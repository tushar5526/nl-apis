import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { AppService } from './app.service';
import { JwtAuthGuard } from './auth/auth-jwt.guard';
import { CreateAssessmentVisitResult } from './dto/CreateAssessmentVisitResult.dto';
import { JwtService } from '@nestjs/jwt';
import { GetMentorSchoolList } from './dto/GetMentorSchoolList.dto';
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly jwtService: JwtService,
  ) {}

  @Get()
  getHello(): string {
    return 'NL Assessments Visit Result App';
  }

  @Roles('Admin', 'OpenRole')
  @UseGuards(JwtAuthGuard)
  @Post('/assessment-visit-results')
  async createAssessmentVisitResults(
    @Body() createAssessmentVisitResultDto: CreateAssessmentVisitResult,
  ) {
    await this.appService.createAssessmentVisitResult(
      createAssessmentVisitResultDto,
    );
    return 'Created';
  }

  @Get('/api/mentor/schools')
  @Roles('Admin', 'OpenRole')
  @UseGuards(JwtAuthGuard)
  getMentorSchoolList(
    @Query() queryParams: GetMentorSchoolList,
    @Headers('authorization') authToken: string,
  ) {
    const decodedAuthTokenData = <Record<string, any>>(
      this.jwtService.decode(authToken.split(' ')[1])
    );

    const mentorPhoneNumber =
      decodedAuthTokenData['https://hasura.io/jwt/claims']['X-Hasura-User-Id'];

    return this.appService.getMentorSchoolListIfHeHasVisited(
      mentorPhoneNumber,
      queryParams.month,
      queryParams.year,
    );
  }
}
