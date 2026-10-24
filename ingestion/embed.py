"""Local CPU embeddings via fastembed (ONNX Runtime, no torch).

The embeddings are only used to pick chunk boundaries, exactly like the
original text-embedding-005 vectors; Discovery Engine indexes the text itself.
"""
from __future__ import annotations

import logging
import os

import numpy as np

from . import config

log = logging.getLogger(__name__)
_models: dict[str, object] = {}


def get_model(name: str = config.EMBED_MODEL):
    if name not in _models:
        from fastembed import TextEmbedding  # lazy: heavy import

        config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
        threads = int(os.environ.get("JRE_EMBED_THREADS", os.cpu_count() or 4))
        log.info("loading embedding model %s (threads=%d, cache=%s)", name, threads, config.MODELS_DIR)
        _models[name] = TextEmbedding(model_name=name, cache_dir=str(config.MODELS_DIR), threads=threads)
    return _models[name]


def embed(texts: list[str], name: str = config.EMBED_MODEL, batch_size: int = 64) -> np.ndarray:
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    model = get_model(name)
    # Documents are embedded as-is (no query prefix), the analogue of RETRIEVAL_DOCUMENT.
    vecs = list(model.embed(texts, batch_size=batch_size))
    return np.asarray(vecs, dtype=np.float32)


def embedder(name: str = config.EMBED_MODEL):
    return lambda texts: embed(texts, name)
