FROM node:20-alpine
RUN apk add --no-cache bash curl unzip git ttyd
WORKDIR /app
RUN mkdir -p /work
VOLUME ["/work"]
EXPOSE 7681
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV CODE_URL=""
ENV CODE_CHECKSUM_SHA256=""
ENV COMMAND="npm run build && node dist/index.js run"
ENV CLAUDE_PROMPT="Analyze the authentication system and suggest improvements"
ENV INSTALL_CMD="npm install && npm run build || true"
ENTRYPOINT ["/entrypoint.sh"]
