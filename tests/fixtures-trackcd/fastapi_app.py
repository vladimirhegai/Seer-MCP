# FastAPI + Flask route + env var fixture.
import os
from fastapi import FastAPI
from flask import Flask, request

app = FastAPI()
flask_app = Flask(__name__)


def get_db_url():
    return os.getenv("DATABASE_URL", "sqlite:///dev.db")


def feature_flag():
    return os.environ.get("FEATURE_FLAG", "off")


def secret_key():
    return os.environ["SECRET_KEY"]


@app.get("/items/{item_id}")
def read_item(item_id: int):
    if item_id < 0:
        return {"error": "negative"}
    elif item_id == 0:
        return {"zero": True}
    else:
        for i in range(item_id):
            if i % 2 == 0:
                continue
        return {"item_id": item_id, "url": get_db_url()}


@app.post("/items")
def create_item(name: str):
    return {"name": name, "key": secret_key()}


@flask_app.route("/health")
def health():
    return {"ok": True}


@flask_app.route("/users", methods=["GET", "POST"])
def users_handler():
    if request.method == "POST":
        return {"created": True}
    return {"list": []}
