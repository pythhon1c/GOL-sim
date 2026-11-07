from __future__ import annotations

import argparse
from pathlib import Path
import uvicorn

from .config import load_config
from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="GOL sim local monitor")
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()
    config = load_config(args.config)
    if args.host:
        config["server"]["host"] = args.host
    if args.port:
        config["server"]["port"] = args.port
    app = create_app(config)
    uvicorn.run(app, host=config["server"]["host"], port=config["server"]["port"], workers=1,
                log_level="info", access_log=False)


if __name__ == "__main__":
    main()
