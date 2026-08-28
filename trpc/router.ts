import { z } from "zod";
import { readModelCatalog } from "@/lib/model-catalog/server";
import { readTaskHistoryPage } from "@/lib/task-history/server";
import { saveChat } from "@/db/services/chats";
import { saveChatSchema } from "@/lib/chat";
import { googleWorkspaceActionSchema } from "@/lib/google-workspace/config";
import {
  disconnectGoogleWorkspace,
  startGoogleWorkspaceAuthorization,
} from "@/lib/google-workspace/server";
import {
  disconnectLinkWallet,
  pollLinkAuthorization,
  startLinkAuthorization,
} from "@/lib/link-wallet/server";
import { managerMutationSchema, managerSnapshotSchema } from "@/lib/manager";
import { toSafeLinkWalletConnection } from "@/lib/manager/link-wallet";
import { applyManagerMutation } from "@/lib/manager/server/store";
import { createTRPCRouter, protectedProcedure } from "./init";

export const appRouter = createTRPCRouter({
  chats: {
    save: protectedProcedure
      .input(saveChatSchema)
      .mutation(({ ctx, input }) => saveChat(ctx.scope, input)),
  },
  googleWorkspace: {
    update: protectedProcedure
      .input(googleWorkspaceActionSchema)
      .mutation(async ({ ctx, input }) => {
        if (input === "disconnect") {
          await disconnectGoogleWorkspace(ctx.scope);
          return { redirectTo: "/?google=disconnected" };
        }

        const callbackUrl = new URL("/", ctx.origin);
        callbackUrl.searchParams.set("google", "connected");
        return {
          redirectTo: await startGoogleWorkspaceAuthorization(
            ctx.scope,
            callbackUrl.toString()
          ),
        };
      }),
  },
  linkWallet: {
    disconnect: protectedProcedure.mutation(async ({ ctx }) =>
      toSafeLinkWalletConnection(await disconnectLinkWallet(ctx.scope))
    ),
    start: protectedProcedure.mutation(async ({ ctx }) =>
      toSafeLinkWalletConnection(await startLinkAuthorization(ctx.scope))
    ),
    status: protectedProcedure.query(async ({ ctx }) =>
      toSafeLinkWalletConnection(await pollLinkAuthorization(ctx.scope))
    ),
  },
  manager: {
    mutate: protectedProcedure
      .input(managerMutationSchema)
      .output(managerSnapshotSchema)
      .mutation(({ ctx, input }) => applyManagerMutation(ctx.scope, input)),
  },
  models: {
    list: protectedProcedure.query(readModelCatalog),
  },
  tasks: {
    list: protectedProcedure
      .input(z.object({ cursor: z.string().nullish() }))
      .query(({ ctx, input }) =>
        readTaskHistoryPage(ctx.scope, input.cursor ?? undefined)
      ),
  },
});

export type AppRouter = typeof appRouter;
