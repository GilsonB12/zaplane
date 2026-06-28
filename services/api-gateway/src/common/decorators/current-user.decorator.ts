import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Payload anexado pela JwtStrategy em req.user
export interface AuthUser {
  userId: string;
  organizationId: string;
  role: string;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | string => {
    const req = ctx.switchToHttp().getRequest();
    return data ? req.user?.[data] : req.user;
  },
);
