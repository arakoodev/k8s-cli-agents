FROM node:20-alpine

RUN apk add --no-cache bash curl git unzip tar ttyd

WORKDIR /work

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]