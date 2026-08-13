import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true preserva o corpo cru — necessário p/ verificar a assinatura
  // X-Hub-Signature-256 do webhook da Meta.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Sem isto, atrás do proxy do Railway TODA requisição chega com o mesmo IP
  // de borda: o rate limit vira um balde único e um cliente sozinho derruba o
  // acesso dos outros. O `1` confia num único salto de proxy (o do Railway) —
  // confiar em mais permitiria forjar X-Forwarded-For e escapar do limite.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.enableCors({ origin: true, credentials: true });

  const prefix = process.env.API_PREFIX || 'api/v1';
  app.setGlobalPrefix(prefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[zaplane] API Gateway ouvindo em http://localhost:${port}/${prefix}`);
}
bootstrap();
