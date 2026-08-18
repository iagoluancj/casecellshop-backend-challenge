export type ProcessOrderJobData = {
  orderId: string;
  outboxEventId: string;
  correlationId: string;
};

export type ProcessOrderOutboxPayload = {
  orderId: string;
  correlationId: string;
};
