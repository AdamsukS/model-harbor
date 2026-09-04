"""Command-line entry point for managed local inference services."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from llm_service.config import ServiceConfig
from llm_service.process import healthcheck, start_backend, stop_backend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage the ModelHarbor service")
    subcommands = parser.add_subparsers(dest="action", required=True)

    start = subcommands.add_parser("start")
    start.add_argument("backend", choices=["mlx", "sglang"], default="mlx", nargs="?")

    stop = subcommands.add_parser("stop")
    stop.add_argument("backend", choices=["mlx", "sglang"], default="mlx", nargs="?")

    health = subcommands.add_parser("health")
    health.add_argument("--http-only", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    config = ServiceConfig.load(root)
    if args.action == "start":
        pid = start_backend(args.backend, config)
        print(f"Started {args.backend} backend as PID {pid}")
        print(f"Log: {config.runtime_dir / f'{args.backend}.log'}")
    elif args.action == "stop":
        stop_backend(args.backend, config)
        print(f"Stopped {args.backend} backend")
    else:
        print(json.dumps(healthcheck(config, not args.http_only), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
