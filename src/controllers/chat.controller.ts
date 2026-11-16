import type { Request, Response } from 'express';
import type { z } from 'zod';
import { requireUser } from '../middlewares/auth.middleware';
import * as chatService from '../services/chat.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { CreateRoomInput, listRoomsSchema } from '../validators/chat.validator';

type ListRoomsQuery = z.infer<typeof listRoomsSchema>['query'];

/** 201 when a new room was made, 200 when the existing one was returned. */
export const createRoom = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const { userId } = req.body as CreateRoomInput;
  const { room, created } = await chatService.createOrGetRoom(me.id, userId);

  if (created) {
    ApiResponse.created(res, { room }, 'Chat started');
  } else {
    ApiResponse.ok(res, { room }, 'Chat already exists');
  }
});

export const listRooms = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const { items, ...meta } = await chatService.listRooms(me.id, req.query as unknown as ListRoomsQuery);
  ApiResponse.ok(res, items, 'Your chats', meta);
});

export const getRoom = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const room = await chatService.getRoom(me.id, req.params.roomId);
  ApiResponse.ok(res, { room }, 'Chat loaded');
});