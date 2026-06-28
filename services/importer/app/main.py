"""Importer — serviço de parsing/validação de contatos (FastAPI).

POST /parse  (multipart: file + default_country)
  → { valid: [...], invalid: [...], stats: {...} }
"""
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from .parser import parse_bytes, extract_contact
from .normalize import normalize

app = FastAPI(title="Zaplane Importer", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/parse")
async def parse(file: UploadFile = File(...), default_country: str = Form("BR")):
    data = await file.read()
    try:
        records = parse_bytes(file.filename, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # parsing inesperado
        raise HTTPException(status_code=422, detail=f"Falha ao ler arquivo: {e}")

    valid: list[dict] = []
    invalid: list[dict] = []
    seen: set[str] = set()
    duplicates = 0

    for rec in records:
        if not isinstance(rec, dict):
            invalid.append({"raw": rec, "reason": "registro não é objeto"})
            continue

        phone, name, attributes = extract_contact(rec)
        if not phone:
            invalid.append({"raw": rec, "reason": "sem coluna de telefone"})
            continue

        norm = normalize(phone, default_country)
        if not norm:
            invalid.append({"raw": rec, "reason": "telefone inválido"})
            continue

        if norm["phone_e164"] in seen:
            duplicates += 1
            continue
        seen.add(norm["phone_e164"])

        valid.append({
            **norm,
            "name": name,
            "attributes": attributes,
        })

    return {
        "valid": valid,
        "invalid": invalid,
        "stats": {
            "total": len(records),
            "valid": len(valid),
            "invalid": len(invalid),
            "duplicates": duplicates,
        },
    }
