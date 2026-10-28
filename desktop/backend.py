"""Frozen desktop-only entry point. Does not load the checkout's .env."""
import hmac
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import threading

import certifi
import uvicorn


def main():
    root = Path(os.environ["PDF2SKILL_DESKTOP_DATA"]).resolve()
    token = os.environ["PDF2SKILL_DESKTOP_TOKEN"]
    if len(token) < 32:
        raise RuntimeError("Missing desktop authentication token")
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    for name in ("tmp", "home", "cache", "logs"):
        (root / name).mkdir(exist_ok=True)
    os.chdir(root)
    os.environ["SSL_CERT_FILE"] = certifi.where()
    os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()
    # Import only after process-local paths and certificate settings are established.
    from frontend import proxy_server as proxy
    from fastapi.responses import JSONResponse

    settings = root / "settings.yaml"
    if not settings.exists():
        resource_root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
        shutil.copyfile(resource_root / "config" / "settings.yaml", settings)
        os.chmod(settings, 0o600)
    proxy.SETTINGS_PATH = settings

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    proxy.ALLOWED_HOSTS = {f"127.0.0.1:{port}"}
    proxy.ALLOWED_ORIGINS = ["pdf2skill://app"]

    @proxy.app.middleware("http")
    async def desktop_auth(request, call_next):
        supplied = request.headers.get("x-pdf2skill-token", "")
        if not hmac.compare_digest(supplied, token):
            return JSONResponse(status_code=401, content={"error": "Unauthorized"})
        return await call_next(request)

    # A closed parent pipe also shuts down the child after an Electron crash/SIGKILL.
    def parent_lifetime():
        # Avoid holding BufferedReader's lock from a daemon during Python finalization.
        while os.read(sys.stdin.fileno(), 4096):
            pass
        os._exit(0)

    threading.Thread(target=parent_lifetime, daemon=True).start()
    print(json.dumps({"port": port}), flush=True)
    server = uvicorn.Server(uvicorn.Config(proxy.app, host="127.0.0.1", port=port,
                                           access_log=False, log_level="warning"))
    server.run(sockets=[listener])


if __name__ == "__main__":
    main()
