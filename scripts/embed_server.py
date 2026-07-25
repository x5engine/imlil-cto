#!/usr/bin/env python3
"""
embed_server.py — tiny HTTP endpoint for batched embeddings on the 3070 Ti.

Runs bge-small-en-v1.5 (384d) in fp16, batches 64-256 texts per call.
Usage:
  python3 embed_server.py [--port 8742] [--model BAAI/bge-small-en-v1.5] [--device cuda:0]

API:
  POST /embed
    {"texts": ["string1", "string2", ...]}
    → {"embeddings": [[0.1, ...], ...], "dim": 384, "count": N}

  GET /health
    → {"status": "ok", "model": "...", "device": "...", "loaded": true}
"""

import sys
import json
import time
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

import torch
from sentence_transformers import SentenceTransformer

MODEL = None
DEVICE = None
DTYPE = torch.float16


class EmbedHandler(BaseHTTPRequestHandler):
    def _respond(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/health':
            self._respond({
                'status': 'ok',
                'model': getattr(MODEL, 'model_card_data', {}).get('base_model', 'bge-small-en-v1.5'),
                'device': str(DEVICE),
                'loaded': MODEL is not None,
                'dtype': str(DTYPE),
            })
        else:
            self._respond({'error': 'not found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path != '/embed':
            self._respond({'error': 'not found'}, 404)
            return

        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            self._respond({'error': 'empty body'}, 400)
            return

        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._respond({'error': 'invalid json'}, 400)
            return

        texts = data.get('texts', [])
        if not texts or not isinstance(texts, list):
            self._respond({'error': 'texts must be a non-empty array'}, 400)
            return

        try:
            with torch.inference_mode():
                embeddings = MODEL.encode(
                    texts,
                    device=DEVICE,
                    convert_to_tensor=True,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                    batch_size=min(len(texts), 256),
                )
                # fp16 → fp32 for JSON
                if embeddings.dtype == torch.float16:
                    embeddings = embeddings.float()
                self._respond({
                    'embeddings': embeddings.cpu().tolist(),
                    'dim': embeddings.shape[-1],
                    'count': len(texts),
                })
        except Exception as e:
            self._respond({'error': str(e)}, 500)

    def log_message(self, format, *args):
        # Quiet — no per-request logging to stdout
        pass


def main():
    global MODEL, DEVICE

    parser = argparse.ArgumentParser(description='Embedding server for 3070 Ti')
    parser.add_argument('--port', type=int, default=8743, help='Port (default 8743)')
    parser.add_argument('--model', type=str, default='BAAI/bge-small-en-v1.5',
                        help='Model name (default BAAI/bge-small-en-v1.5)')
    parser.add_argument('--device', type=str, default='cuda:0')
    args = parser.parse_args()

    DEVICE = torch.device(args.device if torch.cuda.is_available() else 'cpu')
    print(f"Loading {args.model} on {DEVICE}...", flush=True)
    t0 = time.time()

    MODEL = SentenceTransformer(
        args.model,
        device=DEVICE,
        model_kwargs={'torch_dtype': DTYPE},
    )

    print(f"Model loaded in {time.time()-t0:.1f}s ({MODEL.get_sentence_embedding_dimension()}d, {DTYPE})", flush=True)

    server = HTTPServer(('0.0.0.0', args.port), EmbedHandler)
    print(f"Embed server on http://0.0.0.0:{args.port}", flush=True)
    print(f"  POST /embed  |  GET /health", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()