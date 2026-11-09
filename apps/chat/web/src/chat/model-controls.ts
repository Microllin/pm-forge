import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getModels,
  getSessionModel,
  setSessionModel,
  setSessionThinking,
  type AvailableModel,
  type ModelRef,
  type SessionModel,
  type ThinkingLevel,
} from "../api";

/**
 * 一个会话的模型控制：当前模型 / 思考强度、可用模型、切换动作。
 * 输入框上的模型按钮、`/model` 命令、Shift+Tab 共用这一份状态。
 */
export interface ModelControls {
  state: SessionModel | undefined;
  models: AvailableModel[];
  /** 没有可用模型的原因（没接入 provider 等）。 */
  problem: string | null;
  error: string | null;
  pickerOpen: boolean;
  /** 打开选择器时预填的搜索词（`/model opus` 里的 opus）。 */
  pickerQuery: string;
  openPicker: (query?: string) => void;
  closePicker: () => void;
  select: (ref: ModelRef) => Promise<void>;
  /** 切到下一档思考强度（pi 的 Shift+Tab）。 */
  cycleThinking: () => Promise<void>;
  setThinking: (level: ThinkingLevel) => Promise<void>;
}

export function useModelControls(sessionId: string): ModelControls {
  const queryClient = useQueryClient();
  const sessionKey = ["session-model", sessionId];
  const state = useQuery({
    queryKey: sessionKey,
    queryFn: () => getSessionModel(sessionId),
    retry: false,
  });
  const models = useQuery({ queryKey: ["models"], queryFn: getModels });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apply = async (action: () => Promise<SessionModel>): Promise<void> => {
    setError(null);
    try {
      queryClient.setQueryData(sessionKey, await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换失败");
    }
  };

  return {
    state: state.data,
    models: models.data?.models ?? [],
    problem: models.data?.problem ?? (state.error ? state.error.message : null),
    error,
    pickerOpen,
    pickerQuery,
    openPicker: (query = "") => {
      setPickerQuery(query);
      setPickerOpen(true);
    },
    closePicker: () => setPickerOpen(false),
    select: async (ref) => {
      setPickerOpen(false);
      await apply(() => setSessionModel(sessionId, ref));
    },
    cycleThinking: async () => {
      const current = state.data;
      if (!current || current.thinkingLevels.length <= 1) return;
      const i = current.thinkingLevels.indexOf(current.thinkingLevel);
      const next =
        current.thinkingLevels[(i + 1) % current.thinkingLevels.length] ??
        current.thinkingLevel;
      await apply(() => setSessionThinking(sessionId, next));
    },
    setThinking: (level) => apply(() => setSessionThinking(sessionId, level)),
  };
}
