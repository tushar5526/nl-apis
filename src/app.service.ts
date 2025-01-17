import {
  BadRequestException,
  CACHE_MANAGER,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { CreateAssessmentVisitResult } from './dto/CreateAssessmentVisitResult.dto';
import { Prisma } from '@prisma/client';
import { CreateAssessmentSurveyResult } from './dto/CreateAssessmentSurveyResult.dto';
import {
  ActorEnum,
  AssessmentTypeEnum,
  AssessmentVisitResultsStudentModule,
  CacheConstants,
  CacheKeyMentorDailyMetrics,
  CacheKeyMentorDetail,
  CacheKeyMentorMonthlyMetrics,
  CacheKeyMentorSchoolList,
  CacheKeyMentorWeeklyMetrics,
  CacheKeyMetadata,
  Mentor,
  MentorDailyMetrics,
  MentorMonthlyMetrics,
  MentorWeeklyMetrics,
  TypeAssessmentQuarterTables,
  TypeTeacherHomeOverview,
} from './enums';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import {
  getAssessmentVisitResultsQuery,
  getAssessmentVisitResultsStudentsQuery,
  getAssessmentVisitResultStudentOdkResultsQuery,
} from './queries.template';
import { DbTableNotFoundException } from './exceptions/db-table-not-found.exception';
import * as Sentry from '@sentry/minimal';
import { RedisHelperService } from './RedisHelper.service';
import { DailyCacheManager, MonthlyCacheManager, WeeklyCacheManager } from './cache.manager';
import { CreateBotTelemetryDto } from './dto/CreateBotTelemetry.dto';
import { I18nContext, I18nService } from 'nestjs-i18n';

const moment = require('moment');

@Injectable()
export class AppService {
  protected readonly logger = new Logger(AppService.name);
  protected allTables: Record<string, any> = {};

  constructor(
    protected readonly prismaService: PrismaService,
    protected readonly configService: ConfigService,
    protected readonly redisHelper: RedisHelperService,
    @Inject(CACHE_MANAGER) private cacheService: Cache,
    protected readonly i18n: I18nService,
  ) {
    this.prismaService.$queryRawUnsafe(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema='public'
         AND table_type='BASE TABLE';    
    `).then((response) => {
      // @ts-ignore
      for (const table of response) {
        this.allTables[table.table_name] = true;  // push to object map
      }
      this.logger.log('Tables list loaded...');
    }).catch(error => this.logger.error('Unable to fetch tables list from DB!!!', error));
  }

  private monthQuarterMap = {
    '1': 'jan_mar',
    '2': 'jan_mar',
    '3': 'jan_mar',
    '4': 'apr_jun',
    '5': 'apr_jun',
    '6': 'apr_jun',
    '7': 'jul_sep',
    '8': 'jul_sep',
    '9': 'jul_sep',
    '10': 'oct_dec',
    '11': 'oct_dec',
    '12': 'oct_dec',
  };

  public getAssessmentVisitResultsTables(year: null | number = null, month: null | number = null): TypeAssessmentQuarterTables {
    if (year === null) {
      year = new Date().getFullYear();
    }
    if (month === null) {
      month = new Date().getMonth() + 1;  // since getMonth() gives index
    }

    // @ts-ignore
    const quarter: string = this.monthQuarterMap[month.toString()];
    const assessmentVisitResultsTable = `assessment_visit_results_v2_${year.toString()}_${quarter}`;
    const assessmentVisitResultsStudentsTable = `assessment_visit_results_students_${year.toString()}_${quarter}`;
    const assessmentVisitResultStudentOdkResultsTable = `assessment_visit_results_student_odk_results_${year.toString()}_${quarter}`;

    if (!this.allTables[assessmentVisitResultsTable]) {
      const error = `Missing quarter table ${assessmentVisitResultsTable}.`;
      const description = `To fix, execute the below query on DB console: \n${getAssessmentVisitResultsQuery(assessmentVisitResultsTable)}`;
      this.logger.error(error);
      this.logger.debug(description);
      throw new DbTableNotFoundException(error, description);
    } else if (!this.allTables[assessmentVisitResultsStudentsTable]) {
      const error = `Missing quarter table ${assessmentVisitResultsStudentsTable}.`;
      const description = `To fix, execute the below query on DB console: \n${getAssessmentVisitResultsStudentsQuery(assessmentVisitResultsStudentsTable, assessmentVisitResultsTable)}`;
      this.logger.error(error);
      this.logger.debug(description);
      throw new DbTableNotFoundException(error, description);
    } else if (!this.allTables[assessmentVisitResultStudentOdkResultsTable]) {
      const error = `Missing quarter table ${assessmentVisitResultStudentOdkResultsTable}.`;
      const description = `To fix, execute the below query on DB console: \n${getAssessmentVisitResultStudentOdkResultsQuery(assessmentVisitResultStudentOdkResultsTable, assessmentVisitResultsStudentsTable)}`;
      this.logger.error(error);
      this.logger.debug(description);
      throw new DbTableNotFoundException(error, description);
    }

    return {
      assessment_visit_results_v2: assessmentVisitResultsTable,
      assessment_visit_results_students: assessmentVisitResultsStudentsTable,
      assessment_visit_results_student_odk_results: assessmentVisitResultStudentOdkResultsTable,
    };
  }

  async createAssessmentVisitResult(
    createAssessmentVisitResultData: CreateAssessmentVisitResult,
  ) {
    let totalTimeTaken: number = 0;
    const submissionDate = new Date();  // we'll dump all records in the current quarter's table
    let uniqueStudents: Record<string, number> = {};
    const tables = this.getAssessmentVisitResultsTables(submissionDate.getFullYear(), submissionDate.getMonth() + 1); // since getMonth() gives month's index
    try {
      // Checking if Assessment visit result already exist; if not we'll create it
      // @ts-ignore
      let assessmentVisitResult = await this.prismaService[tables.assessment_visit_results_v2].findFirst({
        select: {
          id: true,
        },
        where: {
          submission_timestamp:
            createAssessmentVisitResultData.submission_timestamp,
          mentor_id: createAssessmentVisitResultData.mentor_id,
          grade: createAssessmentVisitResultData.grade,
          subject_id: createAssessmentVisitResultData.subject_id,
          udise: createAssessmentVisitResultData.udise,
        },
      });

      if (assessmentVisitResult) {
        // this is a duplicate submission; let's trigger Sentry event
        Sentry.captureMessage('Duplicate submission detected', {
          user: {
            id: createAssessmentVisitResultData.mentor_id + '',
          },
          extra: {
            submission_timestamp:
              createAssessmentVisitResultData.submission_timestamp,
            mentor_id: createAssessmentVisitResultData.mentor_id,
            grade: createAssessmentVisitResultData.grade,
            subject_id: createAssessmentVisitResultData.subject_id,
            udise: createAssessmentVisitResultData.udise,
          }
        });
        this.logger.log('Duplicate found. Ignoring..');
        return assessmentVisitResult; // we'll not process any further because it's a duplicate
      }

      // filtering student whose module is 'odk'
      const assessmentVisitResultStudents =
        createAssessmentVisitResultData.results.filter(
          (result) =>
            result.module === AssessmentVisitResultsStudentModule.ODK,
        );

      const response = await this.prismaService.$transaction(async (tx) => {
        // @ts-ignore
        assessmentVisitResult = await tx[tables.assessment_visit_results_v2].create({
          select: {
            id: true,
          },
          data: {
            submission_timestamp:
              createAssessmentVisitResultData.submission_timestamp,
            grade: createAssessmentVisitResultData.grade,
            subject_id: createAssessmentVisitResultData.subject_id,
            mentor_id: createAssessmentVisitResultData.mentor_id,
            actor_id: createAssessmentVisitResultData.actor_id,
            block_id: createAssessmentVisitResultData.block_id,
            assessment_type_id:
              createAssessmentVisitResultData.assessment_type_id,
            udise: createAssessmentVisitResultData.udise,
            no_of_student: createAssessmentVisitResultData.no_of_student,
            app_version_code:
              createAssessmentVisitResultData.app_version_code,
            module_result: {}, // populating it default
          },
        });

        const assessmentVisitResultId = assessmentVisitResult.id;

        for (const student of assessmentVisitResultStudents) {
          // Create student submission
          // @ts-ignore
          const assessmentVisitResultStudent = await tx[tables.assessment_visit_results_students].create({
            data: {
              student_name: student.student_name,
              competency_id: student.competency_id,
              module: student.module,
              end_time: student.end_time,
              is_passed: student.is_passed,
              start_time: student.start_time,
              statement: student.statement,
              achievement: student.achievement,
              total_questions: student.total_questions,
              success_criteria: student.success_criteria,
              session_completed: student.session_completed,
              is_network_active: student.is_network_active,
              workflow_ref_id: student.workflow_ref_id,
              total_time_taken: student.total_time_taken,
              student_session: student.student_session,
              assessment_visit_results_v2_id: assessmentVisitResult.id,
              submission_timestamp: createAssessmentVisitResultData.submission_timestamp,
              grade: createAssessmentVisitResultData.grade,
              mentor_id: createAssessmentVisitResultData.mentor_id,
              student_id: student.student_id ?? null,
            },
          });
          uniqueStudents[student.student_session] = student.is_passed ? 1 : 0;  // @TODO fix NIPUN logic
          if (!uniqueStudents.hasOwnProperty(student.student_session)) {
            // since the total time taken is same for a single student for all competencies, we'll consider one entry
            totalTimeTaken += student?.total_time_taken ?? 0;
          }

          const assessmentVisitResultStudentId = assessmentVisitResultStudent.id;

          // creating multiple Assessment visit results student odk results
          // noinspection TypeScriptValidateJSTypes
          // @ts-ignore
          await tx[tables.assessment_visit_results_student_odk_results].createMany({
            data: student.odk_results.map((odkResult) => {
              return {
                question: odkResult.question,
                answer: odkResult.answer,
                assessment_visit_results_students_id:
                  assessmentVisitResultStudentId,
              };
            }),
            skipDuplicates: true,
          });
        }

        // filtering student whose module is not 'odk'
        const nonOdkModuleStudents = createAssessmentVisitResultData.results
          .filter(
            (result) =>
              result.module !== AssessmentVisitResultsStudentModule.ODK,
          )
          .map((result) => {
            if (!uniqueStudents.hasOwnProperty(result.student_session)) {
              // since the total time taken is same for a single student for all competencies, we'll consider one entry
              totalTimeTaken += result?.total_time_taken ?? 0;
            }
            uniqueStudents[result.student_session] = result.is_passed ? 1 : 0;    // @TODO fix NIPUN logic
            return {
              student_name: result.student_name,
              competency_id: result.competency_id,
              module: result.module,
              end_time: result.end_time,
              is_passed: result.is_passed,
              start_time: result.start_time,
              statement: result.statement,
              achievement: result.achievement,
              total_questions: result.total_questions,
              success_criteria: result.success_criteria,
              session_completed: result.session_completed,
              is_network_active: result.is_network_active,
              workflow_ref_id: result.workflow_ref_id,
              total_time_taken: result.total_time_taken,
              student_session: result.student_session,
              assessment_visit_results_v2_id: assessmentVisitResultId,
              submission_timestamp: createAssessmentVisitResultData.submission_timestamp,
              grade: createAssessmentVisitResultData.grade,
              mentor_id: createAssessmentVisitResultData.mentor_id,
              student_id: result.student_id ?? null,
            };
          });

        if (nonOdkModuleStudents.length) {
          // @ts-ignore
          await tx[tables.assessment_visit_results_students].createMany({
            data: nonOdkModuleStudents,
            skipDuplicates: true,
          });
        }

        await this.dumpAssessmentsInHypertable(createAssessmentVisitResultData);  // dump into hypertable
        return assessmentVisitResult;
      }, {
        timeout: 15000,
      });

      // update metrics in cache
      const cacheHomeScreen = new MonthlyCacheManager(
        BigInt(createAssessmentVisitResultData.mentor_id),
        submissionDate.getFullYear(),
        submissionDate.getMonth() + 1,
        this.redisHelper
      );

      const hydrated: boolean = await cacheHomeScreen.hydrate(createAssessmentVisitResultData.udise, createAssessmentVisitResultData.grade, totalTimeTaken, uniqueStudents)
      if (hydrated && createAssessmentVisitResultData.actor_id == ActorEnum.TEACHER && createAssessmentVisitResultData.assessment_type_id == AssessmentTypeEnum.NIPUN_ABHYAS) {
        // Let's now update teacher's metrics cache
        const assessmentsCount = Object.keys(uniqueStudents).length;
        const nipunCount = Object.values(uniqueStudents).reduce((partialSum, a) => partialSum + a, 0);
        const cacheDaily = new DailyCacheManager(BigInt(createAssessmentVisitResultData.mentor_id),
          submissionDate.getFullYear(), submissionDate.getMonth() + 1, submissionDate.getDate(), this.redisHelper);
        if (await cacheDaily.hydrate(assessmentsCount, nipunCount)) {
          // sync weekly metrics too because we synced daily as well
          const cacheWeekly = new WeeklyCacheManager(BigInt(createAssessmentVisitResultData.mentor_id),
            submissionDate.getFullYear(), moment().isoWeek(), this.redisHelper);
          await cacheWeekly.hydrate(assessmentsCount, nipunCount)
        }
      }
      return response;
    } catch (e) {
      this.logger.error(`Error occurred: ${e}`);
      this.handleRequestError(e);
    }
  }

  async getMentorSchoolListIfHeHasVisited(
    mentor: Mentor,
    month: number,
    year: number,
  ) {
    // We'll check if there is data in the cache
    const cachedData = await this.cacheService.get<any>(
      CacheKeyMentorSchoolList(mentor.phone_no, month, year),
    );
    if (cachedData) {
      return cachedData;
    }

    const tables = this.getAssessmentVisitResultsTables(year, month);
    const mentorId = Number(mentor.id);
    const firstDayTimestamp = Date.UTC(year, month - 1, 1, 0, 0, 0);  // first day of current month
    const lastDayTimestamp = Date.UTC(year, month, 1, 0, 0, 0); // first day of next month
    try {
      const response = await this.prismaService.$queryRawUnsafe(`SELECT 
        s.id as school_id,
        s."name" as school_name, 
        s.udise,
        s.district_id,
        d.name as district_name,
        s.block_id,
        b.name as block_name,
        s.nyay_panchayat_id,
        n.name as nyay_panchayat_name,
        (case when EXISTS(SELECT avr2.id from ${tables.assessment_visit_results_v2} as avr2 
            where avr2.udise = 	s.udise 
            and avr2.mentor_id = ${mentorId}
            and avr2.submission_timestamp > ${firstDayTimestamp} 
            and avr2.submission_timestamp < ${lastDayTimestamp})
          THEN true 
          ELSE false
        end) as is_visited,
        s.lat,
        s.long,
        s.geo_fence_enabled
      from school_list as s
      join districts d on d.id = s.district_id
      join blocks b on b.id = s.block_id
      left join nyay_panchayats n on n.id = s.nyay_panchayat_id
      where s.district_id = ${mentor.district_id}
      ${mentor.block_id ? `and s.block_id = ${mentor.block_id}` : ''}`);
      // @ts-ignore
      await this.cacheService.set(CacheKeyMentorSchoolList(mentor.phone_no, month, year), response, { ttl: CacheConstants.TTL_MENTOR_SCHOOL_LIST }); // Adding the data to cache
      return response;
    } catch (e) {
      this.logger.error(`Error occurred: ${e}`);
      this.handleRequestError(e);
    }
  }

  async createAssessmentSurveyResult(
    assessmentSurveyResult: CreateAssessmentSurveyResult,
  ) {
    try {
      // delete assessment survey if already created with this configuration (may throw an exception if record doesn't exists already)
      try {
        await this.prismaService.assessment_survey_result_v2.delete({
          where: {
            subject_id_submission_timestamp_mentor_id_grade_udise: {
              mentor_id: assessmentSurveyResult.mentor_id,
              subject_id: assessmentSurveyResult.subject_id ?? 0,
              grade: assessmentSurveyResult.grade,
              submission_timestamp: assessmentSurveyResult.submission_timestamp,
              udise: assessmentSurveyResult.udise,
            },
          },
        });
      } catch (e) {
        // pass
      }

      // create assessment survey
      return await this.prismaService.assessment_survey_result_v2.create({
        select: {
          id: true,
        },
        data: {
          submission_timestamp: assessmentSurveyResult.submission_timestamp,
          grade: assessmentSurveyResult.grade,
          actor_id: assessmentSurveyResult.actor_id,
          mentor_id: assessmentSurveyResult.mentor_id,
          subject_id: assessmentSurveyResult.subject_id || 0,
          udise: assessmentSurveyResult.udise,
          app_version_code: assessmentSurveyResult.app_version_code,
          assessment_survey_result_questions: {
            createMany: {
              data: assessmentSurveyResult.questions.map((x) => ({
                qid: x.question_id,
                value: x.value,
              })),
            },
          },
        },
      });
    } catch (e) {
      this.logger.error(`Error occurred: ${e}`);
      this.handleRequestError(e);
    }
  }

  /**
   * Transforms the cached redis hashmap response into the actual API response.
   * @param cachedData
   * @param mentor
   * @param month
   * @param year
   * @private
   */
  private async transformHomeScreenMetricCache(cachedData: MentorMonthlyMetrics | Record<string, any>, mentor: Mentor, month: number, year: number) {
    const response: Record<string, any> = {
      visited_schools: parseInt(cachedData.schools_visited),
      total_assessments: parseInt(cachedData.assessments_taken),
      average_assessment_time: parseInt(cachedData.avg_time),
      grades: [
        {
          grade: 1,
          total_assessments: parseInt(cachedData.grade_1_assessments)
        },
        {
          grade: 2,
          total_assessments: parseInt(cachedData.grade_2_assessments)
        },
        {
          grade: 3,
          total_assessments: parseInt(cachedData.grade_3_assessments)
        }
      ],
    };
    if (mentor.actor_id == ActorEnum.TEACHER) {
      const dailyData: MentorDailyMetrics | Record<string, any> = await this.redisHelper.getHash(CacheKeyMentorDailyMetrics(mentor.id, month, moment().date(), year));
      if (Object.keys(dailyData).length === 0) {
        response.teacher_overview = await this.getTeacherHomeScreenMetric(mentor);
      } else {
        const weeklyData: MentorWeeklyMetrics | Record<string, any> = await this.redisHelper.getHash(CacheKeyMentorWeeklyMetrics(mentor.id, moment().isoWeek(), year));
        response.teacher_overview = {
          assessments_total: parseInt(weeklyData.assessments_taken),
          nipun_total: parseInt(weeklyData.nipun_count),
          assessments_today: parseInt(dailyData.assessments_taken),
          nipun_today: parseInt(dailyData.nipun_count)
        }
      }
    }
    return response;
  }

  async getHomeScreenMetric(mentor: Mentor, month: number, year: number) {
    // We'll check if there is data in the cache
    const cachedData: MentorMonthlyMetrics | Record<string, any> = await this.redisHelper.getHash(CacheKeyMentorMonthlyMetrics(mentor.id, month, year));
    if (Object.keys(cachedData).length !== 0) {
      return this.transformHomeScreenMetricCache(cachedData, mentor, month, year);
    }

    const tables = this.getAssessmentVisitResultsTables(year, month);
    const firstDayTimestamp = Date.UTC(year, month - 1, 1, 0, 0, 0);  // first day of current month
    const lastDayTimestamp = Date.UTC(year, month, 1, 0, 0, 0); // 1st day of next month

    try {
      const query = `
          SELECT
              (select count(DISTINCT udise)
               from ${tables.assessment_visit_results_v2} as avr2
               where avr2.mentor_id = ${mentor.id}
                 and avr2.udise > 0
                 and avr2.submission_timestamp > ${firstDayTimestamp}
                 and avr2.submission_timestamp < ${lastDayTimestamp}) AS schools_visited,
              COALESCE(AVG(avrs.total_time_taken), 0) :: int8 AS avg_time ,
              COUNT(DISTINCT avrs.student_session) AS assessments_taken,
              COUNT(DISTINCT CASE WHEN avrs.grade = 1 THEN avrs.student_session END) AS grade_1_assessments,
              COUNT(DISTINCT CASE WHEN avrs.grade = 2 THEN avrs.student_session END) AS grade_2_assessments,
              COUNT(DISTINCT CASE WHEN avrs.grade = 3 THEN avrs.student_session END) AS grade_3_assessments
          FROM ${tables.assessment_visit_results_students} AS avrs
          WHERE avrs.mentor_id = ${mentor.id}
            AND avrs.submission_timestamp > ${firstDayTimestamp}
            AND avrs.submission_timestamp < ${lastDayTimestamp}`;

      const result: Record<string, any> = await this.prismaService.$queryRawUnsafe(query);

      const response: Record<string, any> = {
        visited_schools: result[0]['schools_visited'],
        total_assessments: result[0]['assessments_taken'],
        average_assessment_time: result[0]['avg_time'],
        grades: [
          {
            grade: 1,
            total_assessments: result[0]['grade_1_assessments'],
          },
          {
            grade: 2,
            total_assessments: result[0]['grade_2_assessments'],
          },
          {
            grade: 3,
            total_assessments: result[0]['grade_3_assessments'],
          },
        ],
      };

      // find list of visited schools
      const visitedSchoolsResult: Array<{ udise: bigint }> = await this.prismaService.$queryRawUnsafe(`
        select
          DISTINCT udise as udise
        from
          ${tables.assessment_visit_results_v2} as avr2
        where
          avr2.mentor_id = ${mentor.id}
          and avr2.udise > 0
          and avr2.submission_timestamp > ${firstDayTimestamp} 
          and avr2.submission_timestamp < ${lastDayTimestamp}      
      `);

      const visitedSchools: Array<string> = visitedSchoolsResult.map((item) => {
        return item.udise.toString();
      });

      const cache = new MonthlyCacheManager(BigInt(mentor.id), year, month, this.redisHelper);
      await cache.create(visitedSchools, result[0]);  // create the hashmap in redis

      // creating DB table entry for the very first time
      await this.upsertCacheMentorMetrics(mentor, year, month, result[0]);

      if (mentor.actor_id == ActorEnum.TEACHER) {
        response.teacher_overview = await this.getTeacherHomeScreenMetric(mentor);
      }
      return response;
    } catch (e) {
      this.logger.error(`Error occurred: ${e}`);
      this.handleRequestError(e);
    }
  }

  async findMentorByPhoneNumber(phoneNumber: string): Promise<Mentor | null> {
    // We'll check if there is Mentor in the cache
    const cachedData = await this.cacheService.get<Mentor | null>(
      CacheKeyMentorDetail(phoneNumber),
    );
    if (cachedData) {
      return cachedData;
    }

    const mentor = await this.prismaService.mentor.findFirst({
      where: {
        phone_no: `${phoneNumber}`,
      },
      select: {
        id: true,
        designation_id: true,
        district_id: true,
        districts: true,
        block_id: true,
        blocks: true,
        officer_name: true,
        phone_no: true,
        actor_id: true,
        teacher_school_list_mapping: {
          select: {
            school_list: {
              select: {
                id: true,
                district_id: true,
                districts: true,
                block_id: true,
                blocks: true,
                nyay_panchayat_id: true,
                nyay_panchayats: true,
                name: true,
                udise: true,
                lat: true,
                long: true,
                geo_fence_enabled: true,
              },
            },
          },
        },
      },
    });

    let temp: any = mentor;
    if (mentor) {
      temp.district_name = mentor?.districts?.name ?? '';
      temp.block_town_name = mentor?.blocks?.name ?? '';

      const teacher_school_list_mapping: any = mentor?.teacher_school_list_mapping[0] ?? null;
      if (teacher_school_list_mapping) {
        teacher_school_list_mapping.school_list.school_id = teacher_school_list_mapping?.school_list?.id ?? '';
        teacher_school_list_mapping.school_list.school_name = teacher_school_list_mapping?.school_list?.name ?? '';
        teacher_school_list_mapping.school_list.district_name = teacher_school_list_mapping?.school_list?.districts?.name ?? '';
        teacher_school_list_mapping.school_list.block_name = teacher_school_list_mapping?.school_list?.blocks?.name ?? '';
        teacher_school_list_mapping.school_list.nyay_panchayat_name = teacher_school_list_mapping?.school_list?.nyay_panchayats?.name ?? '';

        delete teacher_school_list_mapping.school_list.districts;
        delete teacher_school_list_mapping.school_list.blocks;
        delete teacher_school_list_mapping.school_list.nyay_panchayats;
        delete teacher_school_list_mapping.school_list.id;
        delete teacher_school_list_mapping.school_list.name;
      }
      temp.teacher_school_list_mapping = teacher_school_list_mapping;
      delete temp.districts;
      delete temp.blocks;
    }
    // @ts-ignore
    await this.cacheService.set(CacheKeyMentorDetail(phoneNumber), temp, { ttl: CacheConstants.TTL_MENTOR_FROM_TOKEN }); // Adding the mentor to cache
    return temp;
  }

  async getMentorDetails(mentor: Mentor, month: null | number = null, year: null | number = null) {
    if (year === null) {
      year = new Date().getFullYear();
    }
    if (month === null) {
      month = new Date().getMonth() + 1;  // since getMonth() gives index
    }

    return {
      mentor: mentor,
      school_list: await this.getMentorSchoolListIfHeHasVisited(mentor, month, year),
      home_overview: await this.getHomeScreenMetric(mentor, month, year),
      examiner_cycle_details: await this.getExaminerCycleDetails(mentor),
    };
  }

  async getMetadata() {
    const cacheData = await this.cacheService.get(CacheKeyMetadata());
    if (cacheData) return cacheData;

    const resp = {
      actors: await this.prismaService.actors.findMany(),
      designations: await this.prismaService.designations.findMany({
        select: {
          id: true,
          name: true,
        },
      }),
      subjects: await this.prismaService.subjects.findMany({
        select: {
          id: true,
          name: true,
        },
      }),
      assessment_types: await this.prismaService.assessment_types.findMany(),
      competency_mapping: await this.prismaService.competency_mapping.findMany({
        select: {
          grade: true,
          learning_outcome: true,
          competency_id: true,
          flow_state: true,
          subject_id: true,
        },
        orderBy: {
          learning_outcome: 'asc',
        },
      }),
      workflow_ref_ids: await this.prismaService.workflow_refids_mapping.findMany({
        select: {
          competency_id: true,
          grade: true,
          is_active: true,
          ref_ids: true,
          subject_id: true,
          type: true,
          assessment_type_id: true,
        },
        where: {
          is_active: true,
        },
      }),
    };
    // @ts-ignore
    await this.cacheService.set(CacheKeyMetadata(), resp, { ttl: CacheConstants.TTL_METADATA });
    return resp;
  }

  async updateMentorPin(mentor: Mentor, pin: number) {
    return await this.prismaService.mentor.update({
      where: {
        id: mentor.id,
      },
      data: {
        pin: pin.toString(),
      },
      select: {
        id: true,
      },
    });
  }

  async getActorHomeScreenRawQueryResult(
    tables: TypeAssessmentQuarterTables,
    mentor: Mentor,
    firstDayTimestamp: number,
    todayTimestamp: number,
    lastDayTimestamp: number): Promise<TypeTeacherHomeOverview | null> {
    try {
      const query = `
          select weekly.assessments_total, weekly.nipun_total, daily.assessments_today, daily.nipun_today
          from (
                   select count(distinct avrs.student_session)                                     as assessments_total,
                          count(distinct case when is_passed = true then avrs.student_session end) as nipun_total
                   from ${tables.assessment_visit_results_students} avrs
                            join ${tables.assessment_visit_results_v2} as avr2
                                 on (avr2.id = avrs.assessment_visit_results_v2_id and avr2.actor_id = ${ActorEnum.TEACHER} and
                                     avr2.assessment_type_id = ${AssessmentTypeEnum.NIPUN_ABHYAS})
                   where avrs.mentor_id = ${mentor.id}
                     and avrs.submission_timestamp > ${firstDayTimestamp}
                     and avrs.submission_timestamp < ${lastDayTimestamp}
               ) as weekly,
               (
                   select count(distinct avrs.student_session)                                     as assessments_today,
                          count(distinct case when is_passed = true then avrs.student_session end) as nipun_today
                   from ${tables.assessment_visit_results_students} avrs
                            join ${tables.assessment_visit_results_v2} as avr2
                                 on (avr2.id = avrs.assessment_visit_results_v2_id and avr2.actor_id = ${ActorEnum.TEACHER} and
                                     avr2.assessment_type_id =
                                     ${AssessmentTypeEnum.NIPUN_ABHYAS})
                   where avrs.mentor_id = ${mentor.id}
                     and avrs.submission_timestamp > ${todayTimestamp}
                     and avrs.submission_timestamp < ${lastDayTimestamp}
               ) as daily;
      `;
      const result: Array<TypeTeacherHomeOverview> = await this.prismaService.$queryRawUnsafe(query);

      return {
        assessments_total: result[0].assessments_total,
        nipun_total: result[0].nipun_total,
        assessments_today: result[0].assessments_today,
        nipun_today: result[0].nipun_today,
      };
    } catch (e) {
      this.logger.error(`Error occurred: ${e}`);
      this.handleRequestError(e);
    }
    return null;
  }

  async getTeacherHomeScreenMetric(mentor: Mentor) {
    const lastDate = new Date();  // it's now() basically
    const temp = new Date();
    const day = lastDate.getDay(), diff = lastDate.getDate() - day + (day == 0 ? -6 : 1); // adjust when day is sunday
    const firstDate = new Date(temp.setDate(diff));

    const tablesForFirstDate = this.getAssessmentVisitResultsTables(firstDate.getFullYear(), firstDate.getMonth() + 1);
    const tablesForLastDate = this.getAssessmentVisitResultsTables(lastDate.getFullYear(), lastDate.getMonth() + 1);

    let responseFirstTable: TypeTeacherHomeOverview | null;
    let responseSecondTable = null;
    if (tablesForFirstDate.assessment_visit_results_v2 === tablesForLastDate.assessment_visit_results_v2) {
      // both tables are same
      const firstDayTimestamp = Date.UTC(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate(), 0, 0, 0);
      const todayTimestamp = Date.UTC(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate(), 0, 0, 0);
      const lastDayTimestamp = lastDate.getTime();

      responseFirstTable = await this.getActorHomeScreenRawQueryResult(
        tablesForFirstDate,
        mentor,
        firstDayTimestamp,
        todayTimestamp,
        lastDayTimestamp
      );
    } else {
      // if the data needs to queried from two tables, we'll query for both separately
      let firstDayTimestamp = Date.UTC(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate(), 0, 0, 0);
      const todayTimestamp = Date.UTC(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate(), 0, 0, 0);
      let lastDayTimestamp = Date.UTC(firstDate.getFullYear(), firstDate.getMonth() + 1, 1, 0, 0, 0); // next month's first date
      responseFirstTable = await this.getActorHomeScreenRawQueryResult(
        tablesForFirstDate,
        mentor,
        firstDayTimestamp,
        todayTimestamp,
        lastDayTimestamp
      );

      firstDayTimestamp = Date.UTC(lastDate.getFullYear(), lastDate.getMonth(), 1, 0, 0, 0);  // first day of current month
      lastDayTimestamp = lastDate.getTime();

      responseSecondTable = await this.getActorHomeScreenRawQueryResult(
        tablesForLastDate,
        mentor,
        firstDayTimestamp,
        todayTimestamp,
        lastDayTimestamp
      );
    }
    let response = responseFirstTable;
    if (responseSecondTable) {
      // we need to merge both table's response
      response = {
        assessments_total: (responseFirstTable?.assessments_total || 0) + (responseSecondTable?.assessments_total || 0),
        nipun_total: (responseFirstTable?.nipun_total || 0) + (responseSecondTable?.nipun_total || 0),
        assessments_today: (responseFirstTable?.assessments_today || 0) + (responseSecondTable?.assessments_today || 0),
        nipun_today: (responseFirstTable?.nipun_today || 0) + (responseSecondTable?.nipun_today || 0)
      }
    }

    const cacheWeekly = new WeeklyCacheManager(mentor.id, lastDate.getFullYear(), moment().isoWeek(), this.redisHelper);
    const cacheDaily = new DailyCacheManager(mentor.id, lastDate.getFullYear(), lastDate.getMonth() + 1,
      lastDate.getDate(), this.redisHelper);
    await Promise.all([
      cacheWeekly.create({
        'assessments_taken': response?.assessments_total ?? 0,
        'nipun_count': response?.nipun_total ?? 0,
      }),   // set weekly stats in redis
      cacheDaily.create({
        'assessments_taken': response?.assessments_today ?? 0,
        'nipun_count': response?.nipun_today ?? 0,
      }),   // set daily stats in redis
    ])
    return response;
  }

  handleRequestError(e: any) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError ||
      e instanceof Prisma.PrismaClientUnknownRequestError ||
      e instanceof Prisma.PrismaClientValidationError
    ) {
      if (Number(this.configService.get('DEBUG', 1)) === 1) {
        throw new BadRequestException(e);
      }
      throw new BadRequestException();
    }

    if (Number(this.configService.get('DEBUG', 1)) === 1) {
      throw new InternalServerErrorException(e);
    }
    throw new InternalServerErrorException();
  }

  async upsertMentorToken(mentor: Mentor, token: string) {
    return this.prismaService.mentor_tokens.upsert({
      where: {
        mentor_id: mentor.id,
      },
      update: {
        token: token,
      },
      create: {
        mentor_id: mentor.id,
        token: token
      },
    });
  }

  private async upsertCacheMentorMetrics(mentor: Mentor, year: number, month: number, result: MentorMonthlyMetrics) {
    // creating DB table entry
    const monthIdentifier = parseInt(year.toString() + (month < 10 ? `0${month.toString()}` : `${month.toString()}`));
    return this.prismaService.cache_mentor_metrics_monthly.upsert({
      where: {
        mentor_id_month: {
          mentor_id: mentor.id,
          month: monthIdentifier
        }
      },
      create: {
        mentor_id: mentor.id,
        month: monthIdentifier,
        schools_visited: parseInt(result.schools_visited.toString()),
        assessments_taken: parseInt(result.assessments_taken.toString()),
        avg_time: parseInt(result.avg_time.toString()),
        grade_1_assessments: parseInt(result.grade_2_assessments.toString()),
        grade_2_assessments: parseInt(result.grade_2_assessments.toString()),
        grade_3_assessments: parseInt(result.grade_3_assessments.toString()),
      },
      update: {
        schools_visited: parseInt(result.schools_visited.toString()),
        assessments_taken: parseInt(result.assessments_taken.toString()),
        avg_time: parseInt(result.avg_time.toString()),
        grade_1_assessments: parseInt(result.grade_2_assessments.toString()),
        grade_2_assessments: parseInt(result.grade_2_assessments.toString()),
        grade_3_assessments: parseInt(result.grade_3_assessments.toString()),
      },
    });
  }

  async dumpAssessmentsInHypertable(assessment: CreateAssessmentVisitResult) {
    console.log('here');
    let assessments = [];
    for (const result of assessment.results) {
      assessments.push({
        subject_id: assessment.subject_id,
        mentor_id: assessment.mentor_id,
        actor_id: assessment.actor_id,
        block_id: assessment.block_id,
        assessment_type_id: assessment.assessment_type_id,
        udise: assessment.udise,
        submission_timestamp: assessment.submission_timestamp,
        submitted_at: (new Date(assessment.submission_timestamp)),
        app_version_code: assessment.app_version_code,
        student_name: result.student_name,
        competency_id: result.competency_id,
        module: result.module,
        end_time: result.end_time,
        is_passed: result.is_passed,
        start_time: result.start_time,
        statement: result.statement,
        achievement: result.achievement,
        total_questions: result.total_questions,
        success_criteria: result.success_criteria,
        session_completed: result.session_completed,
        is_network_active: result.is_network_active,
        workflow_ref_id: result.workflow_ref_id,
        student_session: result.student_session ?? null,
        total_time_taken: result.total_time_taken,
        grade: assessment.grade,
        old_assessment_id: 0,
        old_student_id: 0,
        results_json: result.odk_results,
        student_id: result.student_id ?? null,
      });
    }

    return this.prismaService.assessments.createMany({
      // @ts-ignore
      data: assessments,
      skipDuplicates: true,
    });
  }

  async setMentorBotTelemetry(mentorId: bigint, telemetryObjects: CreateBotTelemetryDto[]) {
    const insertionObjects = [];
    for (const botTelemetry of telemetryObjects) {
      insertionObjects.push({
        mentor_id: mentorId,
        bot_id: botTelemetry.botId,
        action: botTelemetry.action
      })
    }
    return this.prismaService.mentor_bot_telemetry.createMany({
      data: insertionObjects,
      skipDuplicates: true,
    });
  }

  async getMentorBotsWithAction(mentorId: bigint, action: number) {
    return this.prismaService.mentor_bot_telemetry.findMany({
      select: {
        bot_id: true,
      },
      where: {
        mentor_id: mentorId,
        action: action,
      },
    });
  }

  async getExaminerCycleDetails(mentor: Mentor) {
    if (mentor.actor_id != ActorEnum.EXAMINER) {
      return null;
    }
    const query = `
      select *
      from (
         select id,
                start_date,
                end_date,
                name,
                class_1_nipun_percentage,
                class_2_nipun_percentage,
                class_3_nipun_percentage,
                (
                    select jsonb_agg(udise)
                    from assessment_cycle_district_school_mapping
                    where cycle_id = assessment_cycles.id
                      and district_id in (select district_id
                                          from assessment_cycle_district_mentor_mapping
                                          where mentor_id = ${mentor.id}
                                            and cycle_id = assessment_cycles.id)
                ) as udises
         from assessment_cycles
         order by end_date desc
        ) t
      where t.udises is not null
      limit 1
    `;
    const cycle: Array<Record<string, number | string | null | Array<string | object>>> | null = await this.prismaService.$queryRawUnsafe(query);
    if (cycle?.length) {
      cycle[0].start_date = moment(cycle[0].start_date).format('YYYY-MM-DD');
      cycle[0].end_date = moment(cycle[0].end_date).format('YYYY-MM-DD');

      // @ts-ignore
      const udises: null | Array<string> = cycle[0].udises;
      if (udises) {
        cycle[0].schools_list = await this.prismaService.$queryRawUnsafe(`SELECT
            s.id as school_id,
            s."name" as school_name, 
            s.udise,
            s.district_id,
            d.name as district_name,
            s.block_id,
            b.name as block_name,
            s.nyay_panchayat_id,
            n.name as nyay_panchayat_name,
            s.lat,
            s.long,
            s.geo_fence_enabled
          from school_list as s
          join districts d on d.id = s.district_id
          join blocks b on b.id = s.block_id
          left join nyay_panchayats n on n.id = s.nyay_panchayat_id
          where s.udise in (${udises.join(',')})`);
      }
    }
    return cycle ? cycle[0] : null;
  }

  async getExaminerHomeScreenMetric(mentor: Mentor, cycleId: number) {
    const lang: string = I18nContext?.current()?.lang ?? 'en';
    const cycle = await this.prismaService.assessment_cycles.findUniqueOrThrow({
      where: {
        id: cycleId,
      },
    });
    const assessedSchoolsCount = await this.prismaService.assessment_cycle_school_nipun_results.count({
      where: {
        mentor_id: mentor.id,
        cycle_id: cycleId,
      },
    });

    const query = `
      select a.grade, count(distinct a.student_id) as assessed,
        (EXTRACT(EPOCH FROM max(a.submitted_at)) * 1000) as updated_at
      from assessments a
      where a.mentor_id = ${mentor.id}
        and a.actor_id = ${ActorEnum.EXAMINER}
        and a.student_id in (
          select jsonb_array_elements_text(
                         dsm.class_1_students || dsm.class_2_students || dsm.class_3_students) as student_ids
          from assessment_cycle_district_school_mapping dsm
          where dsm.district_id in (
              select district_id
              from assessment_cycle_district_mentor_mapping adsm
              where adsm.mentor_id = ${mentor.id}
                and adsm.cycle_id = ${cycleId})
            and dsm.cycle_id = ${cycleId})
        and a.submitted_at between '${moment(cycle.start_date).format('YYYY-MM-DD HH:mm:ss')}' and '${moment(cycle.end_date).format('YYYY-MM-DD HH:mm:ss')}'
      group by a.grade;
    `;
    const gradeWiseAssessedCount: Array<{ grade: number, assessed: number, updated_at: number }> = await this.prismaService.$queryRawUnsafe(query);
    const grade1Count = gradeWiseAssessedCount.filter(item => item.grade == 1)[0]?.assessed ?? 0;
    const grade1Updated = gradeWiseAssessedCount.filter(item => item.grade == 1)[0]?.updated_at ?? 0;
    const grade2Count = gradeWiseAssessedCount.filter(item => item.grade == 2)[0]?.assessed ?? 0;
    const grade2Updated = gradeWiseAssessedCount.filter(item => item.grade == 2)[0]?.updated_at ?? 0;
    const grade3Count = gradeWiseAssessedCount.filter(item => item.grade == 3)[0]?.assessed ?? 0;
    const grade3Updated = gradeWiseAssessedCount.filter(item => item.grade == 3)[0]?.updated_at ?? 0;
    const updated_at = Math.max(grade1Updated, grade2Updated, grade3Updated);

    return [
      {
        cycle_id: cycleId,
        period: cycle.name,
        updated_at: updated_at,
        insights: [
          {
            type: 'school',
            label: this.i18n.t(`common.Assessed schools`, { lang: lang }),
            count: assessedSchoolsCount,
          },
          {
            type: 'student',
            label: this.i18n.t(`common.Assessed students`, { lang: lang }),
            count: (parseInt(grade1Count.toString()) + parseInt(grade2Count.toString()) + parseInt(grade3Count.toString())),
          },
        ],
      },
      {
        cycle_id: cycleId,
        period: this.i18n.t(`common.Class summary`, { lang: lang }),
        updated_at: updated_at,
        insights: [
          {
            type: 'grade_1',
            label: this.i18n.t(`common.Class 1 Assessed`, { lang: lang }),
            count: grade1Count,
          },
          {
            type: 'grade_2',
            label: this.i18n.t(`common.Class 2 Assessed`, { lang: lang }),
            count: grade2Count,
          },
          {
            type: 'grade_3',
            label: this.i18n.t(`common.Class 3 Assessed`, { lang: lang }),
            count: grade3Count,
          },
        ],
      },
    ];
  }
}
