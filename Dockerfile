FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
# Компилятор не нужен: better-sqlite3 берёт готовый бинарник prebuilds/linux-x64.node (glibc).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production

# node_modules переносим из build-стадии (prod-зависимости после prune).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY prompts ./prompts

EXPOSE 3000
CMD ["node", "dist/index.js"]
