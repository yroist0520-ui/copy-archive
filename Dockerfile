FROM python:3.12-slim

WORKDIR /app
COPY . .

# 数据目录挂卷，保证容器重启后文案不丢
RUN mkdir -p /app/data /app/backups
VOLUME ["/app/data"]

ENV PORT=8080 \
    HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["python3", "server.py"]
