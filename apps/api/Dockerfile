# build จาก root ของ repo: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
# เครือข่ายที่มี proxy ตรวจ TLS: docker build --secret id=build_ca,src=<ca.pem> (ไม่ส่งก็ได้ ไม่ติดไปกับ image)
RUN --mount=type=secret,id=build_ca,target=/run/build-ca.pem,required=false \
  NODE_EXTRA_CA_CERTS=/run/build-ca.pem pnpm install --frozen-lockfile --filter @accounting/api...
COPY apps/api apps/api
RUN --mount=type=secret,id=build_ca,target=/run/build-ca.pem,required=false \
  pnpm --filter @accounting/api build && NODE_EXTRA_CA_CERTS=/run/build-ca.pem pnpm --filter @accounting/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
COPY --from=build /out .
# migration + ตัวตั้งค่าฐานข้อมูล (service migrate ใน infra/docker-compose.yml ใช้ image นี้ ใช้ pg ตัวเดียวกับ API)
COPY db/migrations db/migrations
COPY db/seed db/seed
COPY scripts/migrate.mjs scripts/
COPY infra/bootstrap-db.mjs scripts/
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
