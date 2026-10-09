import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { InputFile } from 'grammy';
import { SETTING, type Repo } from '../db/repo.js';
import { log } from '../logger.js';
import type { Broadcaster } from '../telegram/broadcast.js';

// Проверка идёт раз в час, поэтому порог чуть меньше суток — чтобы время бэкапа не «уползало»
const BACKUP_INTERVAL_MS = 23.5 * 60 * 60 * 1000;

interface BackupDeps {
  sqlite: Database.Database;
  broadcaster: Broadcaster;
  repo: Repo;
}

/**
 * Делает консистентную копию через SQLite Online Backup API (безопасно при открытой БД и WAL)
 * и отправляет её документом в указанные чаты. Возвращает false, если отправлять было некуда.
 */
export async function sendBackup(
  { sqlite, broadcaster }: BackupDeps,
  chatIds: number[],
): Promise<boolean> {
  if (chatIds.length === 0) return false;

  const date = new Date().toISOString().slice(0, 10);
  const tmp = path.join(os.tmpdir(), `ig-autoreply-backup-${Date.now()}.db`);
  try {
    await sqlite.backup(tmp);
    const { size } = await fs.stat(tmp);
    const caption = `🗄 Бэкап базы за ${date} (${Math.ceil(size / 1024)} КБ)`;

    // Файл загружаем один раз, остальным чатам отправляем по file_id
    let fileId: string | undefined;
    let delivered = false;
    for (const chatId of chatIds) {
      try {
        const msg = await broadcaster.api.sendDocument(
          chatId,
          fileId ?? new InputFile(tmp, `ig-autoreply-${date}.db`),
          { caption },
        );
        fileId ??= msg.document?.file_id;
        delivered = true;
      } catch (err) {
        broadcaster.handleError(chatId, err);
      }
    }
    if (delivered) log.info(`Бэкап отправлен (${size} байт, чатов: ${chatIds.length})`);
    return delivered;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function backupIfDue(deps: BackupDeps): Promise<void> {
  const last = Number(deps.repo.getSetting(SETTING.lastBackupAt) ?? 0);
  if (Date.now() - last < BACKUP_INTERVAL_MS) return;
  if (await sendBackup(deps, deps.broadcaster.chatIds())) {
    deps.repo.setSetting(SETTING.lastBackupAt, String(Date.now()));
  }
}
