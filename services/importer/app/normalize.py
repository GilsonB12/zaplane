"""Normalização e validação de telefones para E.164 usando libphonenumber."""
import phonenumbers
from .ddd import uf_for_ddd


def normalize(raw: str, default_country: str = "BR") -> dict | None:
    """Retorna dict normalizado ou None se o número for inválido."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        num = phonenumbers.parse(text, default_country)
    except phonenumbers.NumberParseException:
        return None

    if not phonenumbers.is_valid_number(num):
        return None

    e164 = phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164)
    country = phonenumbers.region_code_for_number(num) or default_country

    ddd = None
    region = None
    if num.country_code == 55:  # Brasil → extrai DDD e UF
        national = phonenumbers.national_significant_number(num)
        if len(national) >= 2:
            ddd = national[:2]
            region = uf_for_ddd(ddd)

    return {
        "phone_e164": e164,
        "country_code": country,
        "ddd": ddd,
        "region": region,
    }
