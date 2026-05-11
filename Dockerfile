FROM node:22-alpine

WORKDIR /app

COPY pipe ./pipe
COPY pipe.yml ./pipe.yml

RUN npm install -g opencode-ai@1.14.24

ENTRYPOINT ["node", "/app/pipe/index.js"]
