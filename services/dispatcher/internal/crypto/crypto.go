// Package crypto decifra segredos gravados pelo gateway (AES-256-GCM,
// formato ivB64:tagB64:cipherB64 — ver services/api-gateway/src/common/crypto.util.ts).
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"fmt"
	"strings"
)

const (
	keyLen = 32 // AES-256
	ivLen  = 12 // GCM nonce padrão
	tagLen = 16 // tamanho do auth tag do GCM
)

// Decrypt decifra um valor no formato "ivB64:tagB64:cipherB64" produzido pelo
// gateway Node (crypto.util.ts / encrypt()). O Node grava o auth tag separado
// do ciphertext; o pacote crypto/cipher do Go espera os dois concatenados
// (ciphertext||tag) em Open, então remontamos isso aqui antes de decifrar.
func Decrypt(enc, keyB64 string) (string, error) {
	parts := strings.Split(enc, ":")
	if len(parts) != 3 {
		return "", fmt.Errorf("crypto: formato inválido, esperado ivB64:tagB64:cipherB64 (%d partes)", len(parts))
	}

	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return "", fmt.Errorf("crypto: APP_ENCRYPTION_KEY inválida (base64): %w", err)
	}
	if len(key) != keyLen {
		return "", fmt.Errorf("crypto: APP_ENCRYPTION_KEY deve ter %d bytes, tem %d", keyLen, len(key))
	}

	iv, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("crypto: iv inválido (base64): %w", err)
	}
	if len(iv) != ivLen {
		return "", fmt.Errorf("crypto: iv deve ter %d bytes, tem %d", ivLen, len(iv))
	}

	tag, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("crypto: tag inválida (base64): %w", err)
	}
	if len(tag) != tagLen {
		return "", fmt.Errorf("crypto: tag deve ter %d bytes, tem %d", tagLen, len(tag))
	}

	ciphertext, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return "", fmt.Errorf("crypto: ciphertext inválido (base64): %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("crypto: falha ao criar cipher AES: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("crypto: falha ao criar GCM: %w", err)
	}

	// Go espera ciphertext||tag concatenados (Node grava separado).
	sealed := append(append([]byte{}, ciphertext...), tag...)

	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", fmt.Errorf("crypto: falha ao decifrar (chave/iv/tag incorretos ou dado corrompido): %w", err)
	}
	return string(plain), nil
}
