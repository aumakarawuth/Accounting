# build จาก root ของ repo: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @accounting/api...
COPY apps/api apps/api
RUN pnpm --filter @accounting/api build && pnpm --filter @accounting/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
COPY --from=build /out .
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
