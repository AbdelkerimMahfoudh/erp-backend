import { Module } from '@nestjs/common';
import { ActingOwnerModule } from '../acting-owner/acting-owner.module';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AppConfigService } from '../common/config/app-config.service';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';
import { SessionsService } from './sessions.service';
import { DevicesService } from './devices.service';
import { OtpService } from './otp/otp.service';
import { VerificationIntentService } from './otp/verification-intent.service';
import { DevicesController } from './devices.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    UsersModule,
    ActingOwnerModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtAccessSecret,
        signOptions: { expiresIn: config.jwtAccessTtl },
      }),
    }),
  ],
  controllers: [AuthController, DevicesController],
  providers: [
    AuthService,
    TokensService,
    SessionsService,
    DevicesService,
    // Stage 4A infrastructure. Nothing in the login flow calls these yet.
    OtpService,
    VerificationIntentService,
    JwtStrategy,
    // Global JWT guard — every route requires a valid token unless @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  // AuthService for the Dukan ERP portal's own sign-in (0099): the same identity, the same checks, its own cookies.
  exports: [AuthService, TokensService, SessionsService, VerificationIntentService, OtpService, DevicesService],
})
export class AuthModule {}
