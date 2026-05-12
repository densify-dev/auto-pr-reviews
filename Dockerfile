FROM node:22-alpine

WORKDIR /app

COPY pipe ./pipe
COPY pipe.yml ./pipe.yml
COPY .opencode ./.opencode

RUN apk add --no-cache curl bash && \
    curl -fsSL https://opencode.ai/install | bash

ENTRYPOINT ["node", "/app/pipe/index.js"]
