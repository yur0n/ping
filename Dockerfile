FROM node:22-slim

RUN apt-get update && apt-get install -y iputils-ping && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm i

RUN mkdir -p /app && touch /app/history.json
RUN chmod 666 /app/history.json

EXPOSE 5050

CMD ["node", "server.js"]

