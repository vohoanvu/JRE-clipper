# Stage 1: Build the application
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Copy the project file and restore dependencies
COPY *.csproj .
RUN dotnet restore

# Copy the rest of the source code
COPY . .

# Publish the application. The output will be in /app/publish/
RUN dotnet publish -c Release -o /app/publish --self-contained --runtime linux-musl-x64

# Stage 2: Create the final runtime image
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app

# Install ffmpeg in the final image
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy the published files directly from /app/publish
COPY --from=build /app/publish/. .

# --- DEBUGGING STEP ---
# This will now correctly list the contents of the /app directory in your build logs
RUN echo "Final contents of /app directory:" && ls -la /app

# Set the entrypoint. This will now find the DLL in /app/JreVideoProcessor.dll
ENTRYPOINT ["dotnet", "JreVideoProcessor.dll"]