import { IEvent } from './../schemas/event.schema';
import { getFirebaseUser } from '../libs/middleware.lib';
import { IUser, UserModel } from '../schemas/user.schema';
import { Request, Response } from 'express';
import { TypedRequestBody } from '../libs/utils.lib';
import Joi from 'joi';
import { validate, validators } from '../libs/validate.lib';
import { StatusCodes } from 'http-status-codes';
import { returnError } from '../libs/error.lib';
import { ITeam, TeamModel } from '../schemas/team.schema';
import { EventModel } from '../schemas/event.schema';
import ical from 'ical-generator';

// DTOs

interface CreateUserDTO {
  firstName: string;
  _id: string;
  lastName: string;
  email?: string;
  events?: String[];
}

export interface UserResponseDTO {
  id: string;
  firstName: string;
  lastName: string;
  events: String[];
}

// Allow updates to every field apart from the userId
interface PatchUserDTO extends Partial<Omit<IUser, '_id'>> {}

interface GetUserTeamsResponseDTO {
  teams: ITeam[];
}

// Find a user using their authToken
export async function getUserById(
  req: Request,
  res: Response<UserResponseDTO>,
) {
  try {
    // Particular firebase user
    const firebaseUser = await getFirebaseUser(req, res);
    const userId = req.params.userId;

    // Check auth
    const authSelf = firebaseUser.uid === userId;

    const userDoc = await UserModel.findById(userId);
    if (!userDoc) {
      return returnError(Error('User Not Found'), res, StatusCodes.NOT_FOUND);
    }

    res.status(StatusCodes.OK).send({
      id: userDoc._id,
      firstName: userDoc.firstName,
      lastName: userDoc.lastName,
      events: authSelf ? userDoc.events : [],
    });
  } catch (err) {
    returnError(err, res);
  }
}

// Create a new user, note that the firebase user must be created before this in order for the firebaseId to be valid
export async function createUser(
  req: TypedRequestBody<CreateUserDTO>,
  res: Response<UserResponseDTO>,
) {
  try {
    const rules = Joi.object<CreateUserDTO>({
      firstName: validators.firstName().required(),
      lastName: validators.lastName().required(),
    });

    const firebaseUser = await getFirebaseUser(req, res);

    // Test if user already exists
    if (await UserModel.findOne({ _id: firebaseUser.uid })) {
      return returnError(
        Error('User Already Exists'),
        res,
        StatusCodes.CONFLICT,
      );
    }

    const formData = validate(res, rules, req.body, { allowUnknown: true });
    // Validation failed, headers have been set, return
    if (!formData) return;

    // _id corresponds to a prior created firebase ID and cannot be generated
    formData._id = firebaseUser.uid;
    formData.email = firebaseUser.email;

    const userDoc = await UserModel.create(formData);

    res.status(StatusCodes.CREATED).send({
      id: userDoc._id,
      firstName: userDoc.firstName,
      lastName: userDoc.lastName,
      events: userDoc.events,
    });
  } catch (err) {
    returnError(err, res);
  }
}

// Update certain fields of a user apart from the users firebaseId (_id)
export async function patchUserById(
  req: TypedRequestBody<PatchUserDTO>,
  res: Response<UserResponseDTO>,
) {
  try {
    const firebaseUser = await getFirebaseUser(req, res);

    const userId = req.params.userId;
    // TODO: create/use remainder of validation rules
    const rules = Joi.object<PatchUserDTO & { userId: string }>({
      userId: validators.id().required(),
      firstName: validators.firstName().optional(),
      lastName: validators.lastName().optional(),
    });
    const formData = validate(
      res,
      rules,
      { ...req.body, userId },
      { allowUnknown: true },
    );
    // Validation failed, headers have been set, return
    if (!formData) return;

    if (firebaseUser.uid !== formData.userId) {
      // return Not found as its more secure to not tell the user if the UID exists or not
      return returnError(Error('User Not Found'), res);
    }

    const userDoc = await UserModel.findOneAndUpdate(
      { _id: formData.userId },
      { $set: formData },
      { new: true },
    );

    if (!userDoc) {
      return returnError(Error('User Not Found'), res);
    }

    res.status(StatusCodes.OK).send({
      id: userDoc._id,
      firstName: userDoc.firstName,
      lastName: userDoc.lastName,
      events: userDoc.events,
    });
  } catch (err) {
    returnError(err, res);
  }
}

// Remove a user from the database
export async function deleteUserById(req: Request, res: Response) {
  try {
    const firebaseUser = await getFirebaseUser(req, res);
    const userId = req.params.userId;

    if (firebaseUser.uid !== userId) {
      // return Not found as its more secure to not tell the user if the UID exists or not
      return returnError(Error('User Not Found'), res);
    }

    const result = await UserModel.deleteOne({ _id: userId });
    if (result.deletedCount === 0) {
      return returnError(Error('User Not Found'), res);
    }
    res.sendStatus(StatusCodes.NO_CONTENT);
  } catch (err) {
    returnError(err, res);
  }
}

// Fetch all the teams that a user belongs to
export async function getUserTeamsById(
  req: Request,
  res: Response<GetUserTeamsResponseDTO>,
) {
  try {
    const firebaseUser = await getFirebaseUser(req, res);
    const userId = req.params.userId;

    if (firebaseUser.uid !== userId) {
      // return Not found as its more secure to not tell the user if the UID exists or not
      return returnError(Error('User Not Found'), res);
    }

    // Either the user is the admin or is a member, is an admin a member?
    const teamDocs = await TeamModel.find({
      $or: [{ admin: userId }, { members: userId }],
    });

    if (!teamDocs) {
      return returnError(Error('Cannot Find User Teams'), res);
    } else {
      res.status(StatusCodes.OK).send({
        teams: teamDocs,
      });
    }
  } catch (err) {
    returnError(err, res);
  }
}

/**
 *
 * @param req Request
 * @param res Response
 * @returns undefined
 *
 * @description Sends a responses of an Ical file containing all events for the user
 */
export async function getUserCalendar(req: Request, res: Response) {
  try {
    const userId = req.params.userId;

    const userDoc = await UserModel.findOne({ _id: userId });
    if (!userDoc) return returnError(Error('User Not Found'), res);

    // find all events for the user
    const eventDocs = await EventModel.find({
      _id: { $in: userDoc.events },
    });

    // find all teams a user is part of
    const teamDocs = await TeamModel.find({
      $or: [{ admin: userId }, { members: userId }],
    });

    // find all events for all teams
    const teamEventDocs = await EventModel.find({
      _id: {
        $in: teamDocs.reduce((acc, team) => {
          return acc.concat(team.events);
        }, []),
      },
    });

    const allEvent: IEvent[] = eventDocs.concat(teamEventDocs);

    // convert to ical
    const calendar = ical({ name: 'Count Me In Calendar' });
    allEvent.forEach((event) => {
      calendar.createEvent({
        start: new Date(event.startDate),
        end: new Date(event.endDate),
        summary: event.title,
        description: event.description,
        location: event.location,
      });
    });

    calendar.serve(res);
  } catch (err) {
    returnError(err, res);
  }
}

// Fetch all the users in the database
export async function getAllUsers(req: Request, res: Response) {
  try {
    const userDocs = await UserModel.find({});
    const users: UserResponseDTO[] = userDocs.map((u) => {
      return {
        id: u._id,
        firstName: u.firstName,
        lastName: u.lastName,
        events: u.events,
      };
    });

    res.status(StatusCodes.OK).send(users);
  } catch (err) {
    returnError(err, res);
  }
}
