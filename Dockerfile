FROM node:22-alpine

WORKDIR /app

# 只拷运行需要的东西；配置和令牌通过 env / volume 注入
COPY package.json ./
COPY src ./src
COPY web ./web
COPY config.example.json ./

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# 默认用 127.0.0.1 的 NapCat；容器里用 host.docker.internal 指向宿主机
ENV ONEBOT_WS=ws://host.docker.internal:3001

CMD ["node", "src/server.mjs"]
