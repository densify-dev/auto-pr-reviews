FROM node:22-alpine

WORKDIR /app

COPY pipe ./pipe
COPY pipe.yml ./pipe.yml

ENTRYPOINT ["node", "/app/pipe/index.js"]
