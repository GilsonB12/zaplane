"""Parsing de CSV/TSV/JSON/XLSX e mapeamento flexível de colunas."""
import io
import json
import pandas as pd

# Ordem de tentativa de codificação para arquivos de texto (CSV/TSV/JSON).
# UTF-8 primeiro (o correto); se falhar, cai para CP1252/ANSI — o padrão do
# Excel no Windows-BR, que grava "João" como o byte 0xE3 (inválido em UTF-8).
# latin-1 mapeia todos os 256 bytes, então é a rede de segurança final.
_TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")


def _read_csv_robust(data: bytes) -> pd.DataFrame:
    """Lê CSV/TSV tentando várias codificações, para não corromper acentos."""
    last_err: Exception | None = None
    for enc in _TEXT_ENCODINGS:
        try:
            # sep=None + engine='python' detecta ',' ou ';' ou tab automaticamente
            return pd.read_csv(io.BytesIO(data), sep=None, engine="python",
                               dtype=str, encoding=enc)
        except (UnicodeDecodeError, UnicodeError) as e:
            last_err = e  # codificação errada — tenta a próxima
            continue
    raise last_err or ValueError("Não foi possível decodificar o CSV.")


def _decode_text(data: bytes) -> str:
    """Decodifica bytes de texto (ex.: JSON) tolerando BOM e ANSI/CP1252."""
    for enc in _TEXT_ENCODINGS:
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return data.decode("latin-1")  # nunca falha

PHONE_KEYS = [
    "phone", "telefone", "celular", "whatsapp", "fone", "numero",
    "número", "number", "msisdn", "contato", "tel",
]
NAME_KEYS = ["name", "nome", "cliente", "contato_nome", "fullname", "razao_social"]


def parse_bytes(filename: str, data: bytes) -> list[dict]:
    """Lê o arquivo e devolve uma lista de registros (dicts)."""
    name = (filename or "").lower()

    if name.endswith(".csv") or name.endswith(".tsv"):
        df = _read_csv_robust(data)
        return df.fillna("").to_dict("records")

    if name.endswith(".json"):
        obj = json.loads(_decode_text(data))
        if isinstance(obj, dict):
            if "contacts" in obj and isinstance(obj["contacts"], list):
                return obj["contacts"]
            for v in obj.values():
                if isinstance(v, list):
                    return v
            return [obj]
        if isinstance(obj, list):
            return obj
        raise ValueError("JSON deve ser uma lista de objetos ou conter uma lista.")

    if name.endswith(".xlsx") or name.endswith(".xls"):
        df = pd.read_excel(io.BytesIO(data), dtype=str)
        return df.fillna("").to_dict("records")

    raise ValueError("Formato não suportado. Use CSV, TSV, JSON ou XLSX.")


def extract_contact(record: dict) -> tuple[str | None, str | None, dict]:
    """Identifica telefone e nome no registro; o resto vira 'attributes'."""
    lower = {str(k).strip().lower(): k for k in record.keys()}

    phone_col = next((lower[c] for c in PHONE_KEYS if c in lower), None)
    name_col = next((lower[c] for c in NAME_KEYS if c in lower), None)

    phone = str(record.get(phone_col)).strip() if phone_col else None
    name = str(record.get(name_col)).strip() if name_col else None
    if name == "":
        name = None

    used = {phone_col, name_col}
    attributes = {
        str(k): record[k]
        for k in record.keys()
        if k not in used and record[k] not in (None, "")
    }
    return phone, name, attributes
