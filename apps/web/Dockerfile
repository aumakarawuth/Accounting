# build จาก root ของ repo: docker build -f apps/web/Dockerfile .
# Next standalone ไม่รวม public/ และ .next/static/ ต้องคัดลอกเอง (docs/dev.md)
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# เครือข่ายที่มี proxy ตรวจ TLS: docker build --secret id=build_ca,src=<ca.pem> (ไม่ส่งก็ได้ ไม่ติดไปกับ image)
RUN --mount=type=secret,id=build_ca,target=/run/build-ca.pem,required=false \
  NODE_EXTRA_CA_CERTS=/run/build-ca.pem pnpm install --frozen-lockfile --filter @accounting/web...
COPY apps/api apps/api
COPY apps/web apps/web
# rewrite /api ของ Next ถูกเขียนลงไฟล์ตอน build (ใช้เมื่อเข้าเว็บตรงไม่ผ่าน Caddy) ปกติ Caddy ส่ง /api ไป API เอง
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN pnpm --filter @accounting/api build && pnpm --filter @accounting/web build \
  && cp -r apps/web/public apps/web/.next/standalone/apps/web/public \
  && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 API_URL=http://api:4000
COPY --from=build /repo/apps/web/.next/standalone .
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
