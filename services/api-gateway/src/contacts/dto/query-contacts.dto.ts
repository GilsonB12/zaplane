import { IsOptional, IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryContactsDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() ddd?: string;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() consent?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  pageSize?: number = 50;
}
