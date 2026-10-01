// Hand-written Room wording for frontend/src/map/res/SegmentEditHelp.ts, swapped in by build.js.
export const SegmentEditHelp = `
## Room Management

A room is a partition of the map as decided by the robot's firmware.
Rooms enable you to just clean one or more predefined areas. You can also give them names.

A room doesn't necessarily have to be an actual room.
There could for example be a room which is just the area around your dining table.

The robot uses the room data to optimize its navigation and drive the most efficient path.


You can select a room by clicking on it. You can then split it into two or give it a name.
If you select another room, you can also join the two to form one bigger room.


Room colors are determined on-the-fly by the map renderer and don't mean anything. They're simply different so that you
can distinguish them from each other. From time to time rooms might also change color because one or more of its pixels changed.

### Common issues/Questions

#### I don't see any rooms

You can only edit rooms if there are any. If you only see a blue map then you have no rooms.

Make sure that you've done a full cleanup task with the robot returning to its dock on its own without any interruption.
This is usually required for the robot to split the map into rooms.

#### I can't split a room

The cutting line has to run from wall to wall. Try dragging it over the whole width/height of the room
instead of just parts of it.

In some room layouts, you also might have to split a room multiple times and then rejoin some of those parts to get
the desired result.

#### Can I delete a room?

No.

`;
