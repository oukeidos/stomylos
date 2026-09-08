export interface RecordedTime {
  utc: string;
  timezone: string | null;
  utc_offset_minutes: number;
  local_date: string;
}
export interface TemporalSource {
  message_id: string;
  sequence: number;
  user_turn: number;
  sent_time: RecordedTime | null;
}
export interface TimeContext {
  reply_reference: RecordedTime;
  sources: TemporalSource[];
}
