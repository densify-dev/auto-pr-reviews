FROM node:22-alpine

WORKDIR /app

COPY pipe ./pipe
COPY pipe.yml ./pipe.yml

RUN apk add --no-cache curl bash ripgrep && \
    curl -fsSL https://opencode.ai/install | bash

COPY .opencode/opencode.json /root/.opencode/opencode.json
COPY .opencode/agent /root/.opencode/agent

ENTRYPOINT ["node", "/app/pipe/index.js"]
