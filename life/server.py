from __future__ import annotations

from contextlib import asynccontextmanager
import hmac
import ipaddress
import json
import os
from pathlib import Path
import tempfile
import threading
from urllib.parse import urlsplit

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from .config import load_config, public_config
from .formats import MAX_IMPORT_CELLS, MAX_TEXT_BYTES, json_chunks, parse_state, rle_chunks
from .native import ROOT
from .runtime import Simulation, StaleGeneration


def is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class RequestLimit:
    def __init__(self, app, limit=MAX_TEXT_BYTES + (1 << 20)):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        consumed = 0
        async def limited_receive():
            nonlocal consumed
            message = await receive()
            consumed += len(message.get("body", b""))
            if consumed > self.limit:
                raise HTTPException(413, "Request body exceeds 65 MiB")
            return message
        await self.app(scope, limited_receive, send)


def create_app(config: dict | None = None, simulation=None) -> FastAPI:
    config = config or load_config()
    remote = not is_loopback(config["server"]["host"])
    token = os.environ.get("LIFE_ACCESS_TOKEN", "")
    if remote and len(token) < 24:
        raise ValueError("Remote binding requires LIFE_ACCESS_TOKEN with at least 24 characters")

    @asynccontextmanager
    async def lifespan(app):
        app.state.simulation = simulation or Simulation(config)
        try:
            yield
        finally:
            if simulation is None:
                app.state.simulation.close()

    app = FastAPI(title="GOL sim", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(RequestLimit)
    viewport_gate = threading.Semaphore(1)
    export_gate = threading.Semaphore(1)

    @app.middleware("http")
    async def security(request: Request, call_next):
        host = request.headers.get("host", "")
        hostname = urlsplit("http://" + host).hostname or ""
        if not remote and hostname not in ("127.0.0.1", "localhost", "::1"):
            return JSONResponse({"detail": "Host is not allowed"}, status_code=403)
        if request.url.path.startswith("/api/"):
            authorization = request.headers.get("authorization", "")
            if token and not hmac.compare_digest(authorization, "Bearer " + token):
                return JSONResponse({"detail": "A valid Bearer access token is required"}, status_code=401)
            origin = request.headers.get("origin")
            if origin and origin != f"{request.url.scheme}://{host}":
                return JSONResponse({"detail": "Cross-origin API requests are disabled"}, status_code=403)
            length = request.headers.get("content-length")
            if length and (not length.isdigit() or int(length) > MAX_TEXT_BYTES + (1 << 20)):
                return JSONResponse({"detail": "Request body exceeds 65 MiB"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(StaleGeneration)
    async def stale_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(ValueError)
    async def value_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(RuntimeError)
    async def runtime_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    def sim(request):
        return request.app.state.simulation

    @app.get("/api/status")
    def status(request: Request):
        return sim(request).status()

    @app.post("/api/control")
    def control(request: Request, data: dict = Body(...)):
        return sim(request).control(data.get("action"), data.get("steps", 1), data.get("generations_per_second", 0),
                                    run_id=data.get("run_id"), generation=data.get("generation"))

    @app.post("/api/new")
    def new(request: Request, data: dict = Body(...)):
        return sim(request).new(data)

    @app.get("/api/viewport")
    def viewport(request: Request, x: int = 0, y: int = 0, width: int = 256,
                 height: int = 256, scale: int = 1, generation: int | None = None, run_id: str | None = None,
                 layer: str = "life", metadata_revision: int | None = None):
        with viewport_gate:
            result = sim(request).viewport(x, y, width, height, scale, generation, run_id, layer, metadata_revision)
            return JSONResponse(result)

    @app.post("/api/import")
    def import_state(request: Request, data: dict = Body(...)):
        if not isinstance(data.get("text"), str):
            raise ValueError("text must contain the uploaded state")
        state = parse_state(data["text"], data.get("format", "rle"))
        return sim(request).replace_state(state)

    @app.get("/api/export")
    def export_state(request: Request, format: str = "json"):
        if format not in ("json", "rle"):
            raise ValueError("format must be json or rle")
        simulation = sim(request)
        with export_gate, simulation.access():
            engine = simulation.engine
            if engine.population > MAX_IMPORT_CELLS:
                raise ValueError("Text export is limited to 2,000,000 live cells; use a segmented checkpoint for larger states")
            handle, filename = tempfile.mkstemp(prefix="exact-life-export-", suffix="." + format)
            path = Path(filename)
            try:
                with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                    if format == "json":
                        stream.writelines(json_chunks(engine.width, engine.height, engine.wrap, engine.generation, engine.cells()))
                    else:
                        stream.writelines(rle_chunks(engine.width, engine.height, engine.wrap, engine.generation, engine.iter_packed()))
                generation = engine.generation
            except BaseException:
                path.unlink(missing_ok=True)
                raise
        return FileResponse(path, media_type="application/json" if format == "json" else "text/plain",
                            filename=f"life-generation-{generation}.{format}", background=BackgroundTask(path.unlink, missing_ok=True))

    @app.get("/api/config")
    def get_config(request: Request):
        simulation = sim(request)
        with simulation.access():
            return public_config(simulation.config)

    @app.put("/api/config")
    def put_config(request: Request, data: dict = Body(...)):
        return public_config(sim(request).update_config(data))

    @app.post("/api/checkpoint")
    def checkpoint(request: Request):
        return sim(request).checkpoint()

    @app.get("/api/patterns")
    def patterns():
        path = ROOT / "web" / "patterns.json"
        return FileResponse(path) if path.exists() else []

    web = ROOT / "web"
    if web.exists():
        app.mount("/", StaticFiles(directory=web, html=True), name="web")
    return app
