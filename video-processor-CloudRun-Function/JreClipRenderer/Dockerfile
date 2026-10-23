# Cloud Run Job image for the clip renderer: .NET 10 runtime + Alpine ffmpeg (x264, dav1d, vpx, opus).
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src
COPY JreClipRenderer.csproj .
RUN dotnet restore -r linux-musl-x64
COPY *.cs ./
RUN dotnet publish -c Release -r linux-musl-x64 --self-contained false --no-restore -o /app

FROM mcr.microsoft.com/dotnet/runtime:10.0-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=build /app .
# The base image ships a non-root "app" user; nothing here needs root.
USER $APP_UID
ENTRYPOINT ["dotnet", "JreClipRenderer.dll"]
