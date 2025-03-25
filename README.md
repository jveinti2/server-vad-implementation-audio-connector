# Server Vad Implementation Audio Connector

Este proyecto es una implementación de referencia para Audio Connector, permitiendo integrar diferentes servicios de voz y procesamiento de lenguaje.

## Arquitectura
![image](https://github.com/user-attachments/assets/a2188d95-2518-43ea-b602-81a4abde0cff)

## Configuración

### Variables de Entorno

Configura las siguientes variables en el archivo `.env` para personalizar la aplicación:

#### Proveedores de Servicios

```
# ASR - Reconocimiento de Voz
# Opciones: "vad" (OpenAI Whisper con detección de voz) o "aws" (AWS Transcribe)
ASR_PROVIDER=vad

# TTS - Síntesis de Voz
# Opciones: "elevenlabs", "openai" o "aws-polly"
TTS_PROVIDER=elevenlabs

# LLM - Modelo de Lenguaje
# Opciones: "openai" (actualmente solo se soporta OpenAI)
LLM_PROVIDER=openai
```

#### API Keys

```
# OpenAI (para Whisper y ChatGPT)
OPENAI_API_KEY=tu_api_key_aqui

# AWS (para Transcribe y Polly)
AWS_ACCESS_KEY_ID=tu_access_key_id
AWS_SECRET_ACCESS_KEY=tu_secret_access_key
AWS_REGION=us-east-1

# ElevenLabs
ELEVENLABS_API_KEY=tu_api_key_aqui
```

#### Configuración de Voces

```
# Voces específicas para cada proveedor TTS
AWS_POLLY_VOICE=Mia         # Voz en español para AWS Polly
OPENAI_VOICE=nova           # Voz en español para OpenAI
ELEVENLABS_VOICE=Mimi       # Voz en español para ElevenLabs
```

#### Otros Ajustes

```
# Puerto del servidor
PORT=8001
```

## Ejecutar la Aplicación

```bash
# Instalar dependencias
npm install

# Ejecutar en desarrollo
npm run dev

# Compilar y ejecutar en producción
npm run build
npm start
```

## Características

- Soporte para múltiples proveedores de ASR, TTS y LLM
- Detección de Actividad de Voz (VAD) para mejorar la transcripción
- Integración con servicios de nube populares
- Arquitectura basada en adaptadores para facilitar extensibilidad
