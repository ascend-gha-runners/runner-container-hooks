FROM swr.cn-north-4.myhuaweicloud.com/opensourceway/node:latest AS runner_builder

WORKDIR /app

COPY . /app/

RUN npm install && npm run bootstrap && npm run build-all

FROM ghcr.nju.edu.cn/actions/actions-runner:2.328.0

COPY --from=runner_builder /app/packages/k8s/dist/index.js /home/runner/k8s/index.js

USER runner
