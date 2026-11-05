from fastapi import FastAPI

app = FastAPI(title="Saral Privacy ML service")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness only: must not load models or touch any dependency."""
    return {"status": "ok"}
