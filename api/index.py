# Vercel's Python runtime imports this module and looks for an ASGI-compatible `app`
# attribute -- main.py's existing FastAPI app is used completely unchanged; this file exists
# only because Vercel's convention expects an entrypoint under api/.
from main import app  # noqa: F401
