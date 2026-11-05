FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
ENV CHECKPOINT_DISABLE=1
RUN pnpm install --frozen-lockfile --filter "@minwon/api..."
RUN pnpm --filter @minwon/api build
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]

# COPY..가 설치보다 우선인 이유는 postinstall이 contracts컴파일과 prisma generate를 실행해서 소스가 먼저 있어야 함
# --filter "@minwon/api..."의 역할은 API그 의존성만 설치해서 Electron 다운로드를 피하기 위함
# dev 의존성을 남기는 이유는 dotenc와 prisma가 