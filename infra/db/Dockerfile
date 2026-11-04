# Postgres 16 + สคริปต์ backup/ซ้อมกู้คืน (ใช้เครื่องมือที่มากับ Postgres: pg_basebackup, pg_verifybackup, pg_dump, pg_archivecleanup)
FROM postgres:16-bookworm
COPY --chmod=755 archive-wal.sh backup.sh backup-loop.sh restore-drill.sh /infra/
COPY postgresql.conf /etc/postgresql/postgresql.conf
# ไดรฟ์ backups/ซ็อกเก็ตเริ่มต้นเป็นของ postgres (named volume คัดลอกเจ้าของจาก image ตอนสร้างครั้งแรก)
RUN mkdir -p /backups/wal /backups/base /backups/dump && chown -R postgres:postgres /backups
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
