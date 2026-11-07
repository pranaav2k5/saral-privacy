# Build context is apps/ml:
#   docker build -t saral-ml:dev apps/ml
FROM python:3.13-slim@sha256:09a17cad02668ae61ece136b4fd36ac3849e14f670ebedb637ea3e15580525bc AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.28@sha256:59240a65d6b57e6c507429b45f01b8f2c7c0bbeee0fb697c41a39c6a8e3a4cfb /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.13-slim@sha256:09a17cad02668ae61ece136b4fd36ac3849e14f670ebedb637ea3e15580525bc
# The pinned base image has not been rebuilt since Debian fixed zlib (CVE-2026-76844 and CVE-2026-85091, both HIGH, fixed in
# 1:1.3.dfsg+really1.3.1-1+deb13u1), and the image scan fails on them. Take only that package from the security archive. Delete
# this step when the pinned base digest already carries the fixed version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade zlib1g \
 && rm -rf /var/lib/apt/lists/*
# pip is not needed at runtime; removing it drops its vendored urllib3 and msgpack from the image.
RUN rm -rf /usr/local/lib/python3.13/site-packages/pip* /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.13 \
 && useradd --create-home --uid 1000 app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY src ./src
ENV PATH="/app/.venv/bin:$PATH" PYTHONPATH=/app/src PYTHONUNBUFFERED=1
USER app
EXPOSE 8000
CMD ["uvicorn", "saral_ml.main:app", "--host", "0.0.0.0", "--port", "8000"]
