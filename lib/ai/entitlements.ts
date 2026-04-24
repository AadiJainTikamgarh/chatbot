import type { UserType } from "@/app/(auth)/auth";
import { isProductionEnvironment } from "../constants";

type Entitlements = {
  maxMessagesPerHour: number;
};

export const entitlementsByUserType: Record<UserType, Entitlements> = {
  guest: {
    maxMessagesPerHour: isProductionEnvironment
      ? 10
      : Number(process.env.DEV_MAX_MESSAGES_PER_HOUR ?? 1000),
  },
  regular: {
    maxMessagesPerHour: isProductionEnvironment
      ? 10
      : Number(process.env.DEV_MAX_MESSAGES_PER_HOUR ?? 1000),
  },
};
