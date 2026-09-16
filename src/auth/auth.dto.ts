import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../common/password-policy.js';
export class LoginDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
export class RefreshDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  refreshToken!: string;
}
