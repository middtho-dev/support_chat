FROM alpine:3.23
RUN apk add --no-cache python3 squashfs-tools ca-certificates
WORKDIR /app
COPY image.py presets.py builder.py server.py enroll.sh enroll.init ./
RUN mkdir /data && chmod 700 /data
ENV FIRMWARE_DIR=/data
EXPOSE 7700
CMD ["python3", "server.py"]
