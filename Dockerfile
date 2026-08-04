# syntax=docker/dockerfile:1
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -o /out/gateway ./cmd/gateway

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/gateway /usr/local/bin/gateway
COPY ui /app/ui
ENV HTTP_ADDR=:3000
ENV UI_DIR=/app/ui
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD curl -fsS http://127.0.0.1:3000/health || exit 1
CMD ["gateway"]
