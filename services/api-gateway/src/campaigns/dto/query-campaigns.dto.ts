import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

const STATUSES = ['draft', 'scheduled', 'queuing', 'sending', 'completed', 'failed', 'canceled'];

export class QueryCampaignsDto {
  @IsOptional() @IsIn(STATUSES)
  status?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  pageSize?: number = 20;
}
