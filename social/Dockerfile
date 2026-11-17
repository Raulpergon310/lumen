FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
ENV PORT=8097 DATA_DIR=/data
VOLUME /data
EXPOSE 8097
CMD ["node", "server.js"]
