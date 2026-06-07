import {z}  from "zod";

export const UserRegisterSchema = z.object({
    username :z.string().lowercase(),
    email: z.email(),
    password: z.string().trim().min(4, 'password must have atleast 4 char')

})

export const UserLoginSchema = z.object({
    username:z.string().toLowerCase(),
    password: z.string().trim().min(4, 'password must have atleast 4 char')
})

