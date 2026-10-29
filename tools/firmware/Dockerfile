FROM alpine:3.23
RUN apk add --no-cache python3 squashfs-tools ca-certificates
WORKDIR /app
COPY image.py presets.py builder.py bundle.py server.py enroll.sh enroll.init provision.sh install.ps1 ./
RUN adduser -D -u 10001 firmware && mkdir /data && chown firmware:firmware /data && chmod 700 /data
ENV FIRMWARE_DIR=/data
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7700/health', timeout=3).read()"
USER firmware
CMD ["python3", "server.py"]
